import {
  AppError,
  type GenderMatchingMode,
  genderMatchingMode,
  type RoomTypeName,
  type ServiceShape,
  type TherapistSkill,
} from '@berelax/shared'
import type { Sql } from '../connection.ts'
import {
  type ScheduledAppointmentRow,
  type TherapistPoolCtesQuery,
  therapistPoolCtes,
} from '../repositories/eligibility.ts'

/**
 * The availability **read** path (B-AVAIL-07). One indexed statement per request, memoised for seconds,
 * and never the authority.
 *
 * ## The cache is an optimisation; the database is the authority
 *
 * Everything in this module is arranged around one sentence: a memo of a computed answer may be wrong, and
 * nothing here is allowed to make that dangerous. The booking transaction (B-AVAIL-06) re-reads the
 * committed rows under the room lock and re-applies `assignShape` before it writes, so a caller booking a
 * slot from a list that has gone stale receives a named `slot_taken` refusal rather than a double booking.
 * That is the property the whole design leans on, and it is the reason a memo is *safe* — not the reason it
 * is *correct*, which is the epoch below.
 *
 * `scripts/check-schema-conventions.mjs` forbids a slot table, an `availability_cache` and a materialised
 * view of either, and the reason it gives is right: a stored answer is stale from the next block, closure,
 * shift change or walk-in. So the memo lives **in process**, for tens of seconds, and it is validated
 * against a number the database owns. 0045 adds `availability_epoch`: one integer per trading date,
 * advanced by a trigger on each of the four write types that can change an answer — `appointment`, `shift`,
 * `resource_block` and APPROVED `leave_request`. A holder compares the integer it recorded against the
 * current one in a single primary-key lookup, and throws the memo away when they differ.
 *
 * That makes the two halves of the manifest's requirements separable, which they have to be:
 *
 *   - {@link queryAvailability} validates the epoch, so a write purges the tag. Each of the four write
 *     types is asserted on its own, by `availability_epoch.last_cause`; one test that writes all four and
 *     re-queries proves only that at least one purge works.
 *   - {@link peekAvailabilityCache} reads a memo **without** validating it, which is what a stale caller
 *     holds — a rendered page, a phone in a pocket, a retry after a timeout. It is the honest way to write
 *     "a deliberately stale cache never sells a non-existent slot": prime the memo, commit a booking out
 *     of band, read the memo back, and book from it. The refusal comes from `bookSlot`, by name.
 *
 * ## One round trip, and what that does and does not include
 *
 * {@link readAvailabilityFacts} is exactly one statement. It returns the trading window, the catalogue
 * figures, the shape, the compatible room types, the rooms, the blocks, every appointment overlapping the
 * day, the therapist pool with its presence net of approved leave, and the epoch — one row, JSON
 * aggregates. The therapist half is B-AVAIL-04's own SQL, composed in as {@link therapistPoolCtes} rather
 * than retyped: a second implementation of "is this therapist bookable" is exactly what that unit exists
 * to prevent.
 *
 * Two things are deliberately **not** in that round trip, and both are arguments to the request:
 *
 *   - `minLeadMinutes` and `maxAdvanceDays` are F09 settings and `readSetting` is the one read path for a
 *     setting — it checks the key against the registry and falls back to the registry's declared default.
 *     Reading them in this statement would mean spelling those defaults in SQL, which is a second source
 *     of truth for a provisional value (Y9-lead). {@link readAvailabilityLimits} reads them, and it is a
 *     separate call on purpose: a setting changes at human speed and is cached for minutes, where a slot
 *     list is cached for seconds.
 *   - `genderMatching` comes from `readGenderMatching`, for the same reason and with the same hazard:
 *     absent is strict, and a query that read the mode itself could reach the permissive branch through a
 *     default written twice.
 *
 * ## Why the appointment read is keyed on the PERIOD and widened
 *
 * `readCommittedAppointments` (B-AVAIL-04) narrows on `trading_date`, which is right for the booking
 * transaction: it is about one date's committed rows. This query asks a different question — what occupies
 * any room and any therapist during a span of instants — and the span is not the trading window itself. A
 * candidate slot's ROOM interval is `[start, end + turnaround)` and its THERAPIST interval is
 * `[start - buffer, end + buffer)`, so an appointment that ends before the day opens can still hold a
 * therapist into the day's first slot. The window is therefore padded by
 * {@link AVAILABILITY_OCCUPANCY_PAD_MINUTES} at both ends — the ceilings 0038 puts on the two snapshotted
 * figures, not the configured values, because the configured value of somebody else's appointment is not
 * this request's to assume. 0045's `appointment_period_idx` is the GiST index that serves it;
 * `appointment_room_period_idx` (0024) leads with `room_id`, which this query does not constrain.
 *
 * The padding also fixes the direction of an error. Over-reading appointments can only ever make the
 * answer narrower — a slot withheld — and under-reading offers one the database refuses at COMMIT.
 */

/**
 * Minutes the appointment read is widened past each end of the trading window.
 *
 * 240 is `appointment_turnaround_bounded`'s ceiling and comfortably above
 * `appointment_therapist_buffer_bounded`'s 60, so no committed appointment can hold a resource inside the
 * window from outside this range. Deliberately the CEILING and not the configured turnaround: the figure
 * that matters is the one snapshotted onto the other appointment, which this request cannot know.
 */
export const AVAILABILITY_OCCUPANCY_PAD_MINUTES = 240

/**
 * How long a memo may be served, in milliseconds.
 *
 * The manifest says 30–60 s. 30 is the **shortest** of that band, which is the strictest reading and the
 * direction docs/04 says an unconfirmed figure resolves in: a shorter memo costs a recomputation, a longer
 * one widens the window in which a caller holds a list the epoch has not been asked about.
 */
export const DEFAULT_AVAILABILITY_TTL_MS = 30_000

/** The longest the band allows. {@link createAvailabilityCache} refuses anything above it. */
export const MAX_AVAILABILITY_TTL_MS = 60_000

/**
 * Trading dates examined either side of the one asked about, when a day comes back empty.
 *
 * Seven, and it is a bound rather than a preference: each date is its own round trip, so an unbounded
 * search would turn one empty day into ninety queries — `booking.max_advance_days` is provisionally 90 —
 * every time the booking page rendered a full Saturday.
 */
export const DEFAULT_ALTERNATIVE_SEARCH_DAYS = 7

/** Every reason this query refuses to answer. Callers branch on these, never on prose. */
export const AVAILABILITY_REFUSALS = [
  'availability_not_solved',
  'not_a_trading_date',
  'variant_not_found',
  'shape_not_offered',
  'no_compatible_room_type',
  'waitlist_window_already_joined',
  'waitlist_window_empty',
  'availability_ttl_too_long',
] as const
export type AvailabilityRefusal = (typeof AVAILABILITY_REFUSALS)[number]

/** `waitlist_one_row_per_window`, the UNIQUE NULLS NOT DISTINCT key that makes a repeat join a no-op. */
export const WAITLIST_WINDOW_CONSTRAINT = 'waitlist_one_row_per_window'
/** `23505`, unique_violation. */
const UNIQUE_VIOLATION = '23505'

const refusal = (
  kind: 'conflict' | 'validation' | 'invariant_violated',
  name: AvailabilityRefusal,
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
 * Translates a PostgreSQL error from the waitlist into a named `AppError`, or `null`.
 *
 * Exported for the reason `bookingError` and `journalError` are: a caller that composes its own INSERT
 * into the same unit of work meets the constraint itself, and the refusal it gets should name the rule
 * rather than carry a driver message. Anything unrecognised returns `null` and is rethrown — a
 * translation that guessed would report a disk error as a duplicate waitlist entry.
 */
export function availabilityError(err: unknown): AppError | null {
  if (sqlState(err) !== UNIQUE_VIOLATION) return null
  if (constraintOf(err) !== WAITLIST_WINDOW_CONSTRAINT) return null
  return refusal(
    'conflict',
    'waitlist_window_already_joined',
    `${WAITLIST_WINDOW_CONSTRAINT}: this customer is already waiting for that window on that variant. ` +
      'The key is UNIQUE NULLS NOT DISTINCT, so "any therapist" is one key rather than a new one per ' +
      'join, which is what makes a repeat join idempotent instead of a row per page refresh.',
    { sqlState: sqlState(err), constraint: constraintOf(err) },
  )
}

/** The refusal an error carries, or `null`. Lets a caller branch without matching on the message. */
export function availabilityRefusalOf(err: unknown): AvailabilityRefusal | null {
  const translated = err instanceof AppError ? err : availabilityError(err)
  const name = translated?.details['refusal']
  return AVAILABILITY_REFUSALS.includes(name as AvailabilityRefusal)
    ? (name as AvailabilityRefusal)
    : null
}

// ------------------------------------------------------------------------------------------------
// The request, and the tag it is cached under
// ------------------------------------------------------------------------------------------------

export interface AvailabilityRequest {
  /** A trading date as `YYYY-MM-DD`. Never a calendar date: 01:30 belongs to the PREVIOUS one. */
  readonly tradingDate: string
  readonly serviceVariantId: string
  /** The footprint. `solo` unless the caller is asking about a Four Hands or a Couple Massage. */
  readonly shape?: ServiceShape
  /**
   * Narrows the therapists considered — "the therapist I saw last time".
   *
   * Absent means every employee, which is not the same as an empty array: an empty array is a request
   * about nobody, and it is answered with zero slots rather than with the whole roster.
   */
  readonly therapistIds?: readonly string[]
  /** The **client's** gender, when it was collected. Under strict matching, absence refuses. */
  readonly clientGender?: 'female' | 'male'
  /** `booking.same_gender_matching`, from `readGenderMatching`. **Absent is strict.** */
  readonly genderMatching?: GenderMatchingMode
  /** `booking.min_lead_minutes`, from {@link readAvailabilityLimits}. */
  readonly minLeadMinutes: number
  /** `booking.max_advance_days`, from {@link readAvailabilityLimits}. */
  readonly maxAdvanceDays: number
  /** The grid step. Omitted means the solver's own default. */
  readonly stepMinutes?: number
}

/**
 * The cache key, as a string.
 *
 * Over the three axes the manifest names — trading date, service variant, therapist filter — plus the
 * three fields that change the ANSWER for the same three axes: the shape, the client's gender and the
 * matching mode. Leaving any of those out of the key is the bug this function exists to prevent: two
 * requests differing only in the client's gender would share a memo, and the second caller would be shown
 * the first caller's cross-gender slots under a strict rule.
 *
 * `minLeadMinutes` and `maxAdvanceDays` are **also** in the key. They are settings rather than request
 * fields, and a change to one of them is a change to every answer; the registry declares both as
 * invalidating the `availability` cache tag, and this is what makes that true for the memo as well.
 *
 * Therapist ids are sorted and de-duplicated, so a caller assembling the same filter from two code paths
 * produces one key. An absent filter and an empty one are spelled differently — `*` and `-` — because they
 * are different questions.
 */
export function availabilityCacheTag(request: AvailabilityRequest): string {
  const therapists =
    request.therapistIds === undefined
      ? '*'
      : request.therapistIds.length === 0
        ? '-'
        : [...new Set(request.therapistIds)].sort().join(',')
  return [
    request.tradingDate,
    request.serviceVariantId,
    request.shape ?? 'solo',
    therapists,
    request.clientGender ?? 'unknown',
    // Normalised, never the raw value: two spellings of one mode would be two tags, and a stale
    // `'off'` from an older build reads as strict everywhere else.
    genderMatchingMode(request.genderMatching),
    String(request.minLeadMinutes),
    String(request.maxAdvanceDays),
    String(request.stepMinutes ?? 'default'),
  ].join('|')
}

// ------------------------------------------------------------------------------------------------
// The facts, in one statement
// ------------------------------------------------------------------------------------------------

export interface AvailabilityDayHours {
  readonly tradingDate: string
  readonly opensAt: number
  readonly closesAt: number
  /** Local `HH:MM` in Asia/Dubai, derived from the materialised instants — never a second source. */
  readonly open: string
  readonly close: string
}

export interface AvailabilityVariantFacts {
  readonly serviceVariantId: string
  readonly durationMinutes: number
  readonly style: string
  readonly treatmentKey: string
  /** `service.turnaround_minutes`, the same column `createBooking` snapshots from. */
  readonly turnaroundMinutes: number
  readonly requiredSkill: TherapistSkill
}

export interface AvailabilityShapeFacts {
  readonly shape: ServiceShape
  readonly therapistsRequired: number
  readonly roomsRequired: number
  readonly minRoomCapacity: number
  readonly requiredRoomType?: RoomTypeName
  readonly therapistBufferMinutes: number
}

export interface AvailabilityRoomFacts {
  readonly id: string
  readonly roomType: RoomTypeName
  readonly capacity: number
  readonly isBookable: boolean
}

/**
 * A `resource_block` row: room unavailability that is not a booking.
 *
 * `kind` and `reason` are carried even though no arithmetic reads them, and that is deliberate. "No
 * availability" is the answer the front desk cannot act on; *"the wet room is down for a deep clean until
 * Thursday"* is the sentence it needs, and `roomUnavailableReason` in `@berelax/core` exists to produce
 * it. Dropping them here would make that unreachable without a second read of the same rows.
 */
export interface AvailabilityBlockFacts {
  readonly roomId: string
  readonly period: { readonly startsAt: number; readonly endsAt: number }
  readonly kind: 'maintenance' | 'deep_clean' | 'hold' | 'other'
  readonly reason: string
}

export interface AvailabilityTherapistFacts {
  readonly therapistId: string
  readonly skills: readonly TherapistSkill[]
  readonly gender?: 'female' | 'male'
}

export interface AvailabilityShiftFacts {
  readonly therapistId: string
  readonly period: { readonly startsAt: number; readonly endsAt: number }
}

/** Everything one availability request needs, as read in one round trip. */
export interface AvailabilityFacts {
  readonly tradingDate: string
  /**
   * `availability_epoch.epoch` as a **string**, or null when the date has never been written to.
   *
   * A string because `createConnection` maps PostgreSQL `bigint` to a string rather than to a lossy JS
   * number, and because the only operation performed on it is equality — a generation counter is not an
   * amount. `null` compares equal to `null`, which is correct: nothing has been written, so a memo taken
   * when nothing had been written is still current.
   */
  readonly epoch: string | null
  /** Hours for the trading date and for the dates `resolveTradingDate` needs around `now`. */
  readonly hours: readonly AvailabilityDayHours[]
  /** Null when the premises does not trade that date: a closed date is ABSENT from `business_day`. */
  readonly day: AvailabilityDayHours | null
  readonly variant: AvailabilityVariantFacts | null
  readonly shape: AvailabilityShapeFacts | null
  readonly compatibleRoomTypes: readonly RoomTypeName[]
  readonly rooms: readonly AvailabilityRoomFacts[]
  readonly blocks: readonly AvailabilityBlockFacts[]
  readonly appointments: readonly ScheduledAppointmentRow[]
  readonly therapists: readonly AvailabilityTherapistFacts[]
  readonly shifts: readonly AvailabilityShiftFacts[]
  readonly excluded: readonly { readonly therapistId: string; readonly reason: string }[]
}

interface FactsRow {
  epoch: string | null
  hours: AvailabilityDayHours[] | null
  variant: AvailabilityVariantFacts | null
  shape:
    | (Omit<AvailabilityShapeFacts, 'requiredRoomType'> & {
        requiredRoomType: RoomTypeName | null
      })
    | null
  compat: RoomTypeName[] | null
  rooms: AvailabilityRoomFacts[] | null
  blocks: AvailabilityBlockFacts[] | null
  appointments:
    | {
        id: string
        roomId: string
        therapistId: string
        deliveryId: string
        roomPlaces: number
        startsAt: number
        endsAt: number
        turnaroundMinutes: number
        therapistBufferMinutes: number
      }[]
    | null
  pool:
    | {
        therapistId: string
        gender: 'female' | 'male' | null
        skills: TherapistSkill[]
        reason: string | null
      }[]
    | null
  presence: { therapistId: string; startsAt: number; endsAt: number }[] | null
}

/** Whole days added to an ISO date, in UTC. Used only to bracket the hours lookup, never to solve. */
function shiftIsoDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

/**
 * The calendar date `now` falls on in Asia/Dubai.
 *
 * Needed only to decide WHICH `business_day` rows to fetch: `resolveTradingDate` asks about `now`'s own
 * calendar date and the one before it, because 01:30 belongs to the previous trading date. The trading
 * date itself is resolved by `@berelax/core` from the hours this returns, never here — `packages/db` does
 * not own that rule and a second implementation of it would disagree at 02:00.
 */
function dubaiCalendarDate(now: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dubai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(now))
  const at = (type: string): string => parts.find((part) => part.type === type)?.value ?? ''
  return `${at('year')}-${at('month')}-${at('day')}`
}

/**
 * The one statement, as a fragment rather than as a result.
 *
 * Built and returned unawaited, which is what lets {@link readAvailabilityFacts} execute it and
 * {@link explainAvailabilityFacts} put `EXPLAIN (ANALYZE, FORMAT JSON)` in front of the SAME text. A plan
 * assertion against a second copy of the query proves something about the copy: the first thing that
 * drifts is the predicate the index was supposed to serve, and the plan test goes on passing.
 *
 * The therapist half is {@link therapistPoolCtes} — B-AVAIL-04's SQL, composed rather than copied. The
 * appointment half runs through `appointment_period_idx` (0045) against a window widened by
 * {@link AVAILABILITY_OCCUPANCY_PAD_MINUTES}; the window is an InitPlan scalar subquery rather than a
 * joined CTE, so the overlap becomes an index qual against a run-time constant.
 */
function availabilityFactsStatement(sql: Sql, request: AvailabilityRequest, now: number) {
  const shape = request.shape ?? 'solo'
  const calendarDate = dubaiCalendarDate(now)
  // The trading date being solved, plus the two calendar dates `resolveTradingDate` consults for `now`.
  // De-duplicated, because they coincide whenever the query is about today.
  const hoursDates = [
    ...new Set([request.tradingDate, shiftIsoDate(calendarDate, -1), calendarDate]),
  ]
  const poolQuery: TherapistPoolCtesQuery = {
    tradingDate: request.tradingDate,
    // The skill the treatment's STYLE requires, as a SQL EXPRESSION rather than a value.
    //
    // This is what makes the whole read one round trip. The skill comes from `service_skill` by way of
    // the variant's style (ADR 0021), so it is not known until the variant has been read — and reading
    // it first would be a second statement. `av_variant` is defined earlier in the same WITH clause,
    // which is why a scalar subquery over it is legal here and why the pool and the variant cannot
    // disagree about which skill was required.
    requiredSkill: sql`(select v.required_skill from av_variant v)`,
    ...(request.therapistIds === undefined ? {} : { employeeIds: request.therapistIds }),
    ...(request.clientGender === undefined ? {} : { clientGender: request.clientGender }),
    ...(request.genderMatching === undefined ? {} : { genderMatching: request.genderMatching }),
  }

  return sql<FactsRow[]>`
    with av_day as (
      select trading_date::text as trading_date,
             opens_at,
             closes_at,
             to_char(opens_at  at time zone 'Asia/Dubai', 'HH24:MI') as open_time,
             to_char(closes_at at time zone 'Asia/Dubai', 'HH24:MI') as close_time
        from business_day
       where trading_date = any(${hoursDates}::date[])
    ),
    av_solved as (
      select * from av_day where trading_date = ${request.tradingDate}
    ),
    -- The read window, widened at BOTH ends by the ceilings 0038 puts on the two snapshotted figures.
    -- An appointment ending before the day opens can still hold a therapist into the day's first slot,
    -- because the therapist interval is [start - buffer, end + buffer).
    av_window as (
      select tstzrange(
               opens_at  - ${`${AVAILABILITY_OCCUPANCY_PAD_MINUTES} minutes`}::interval,
               closes_at + ${`${AVAILABILITY_OCCUPANCY_PAD_MINUTES} minutes`}::interval,
               '[)'
             ) as padded
        from av_solved
    ),
    av_variant as (
      select v.id::text           as id,
             v.duration_minutes,
             s.style::text        as style,
             s.treatment_key::text as treatment_key,
             s.turnaround_minutes,
             sk.required_skill::text as required_skill
        from service_variant v
        join service s       on s.id = v.service_id
        join service_skill sk on sk.style = s.style
       where v.id = ${request.serviceVariantId}
    ),
    av_shape as (
      select srs.shape::text              as shape,
             srs.therapists_required,
             srs.rooms_required,
             srs.min_room_capacity,
             srs.required_room_type::text as required_room_type,
             srs.therapist_buffer_minutes
        from av_variant v
        join service_resource_shape srs
          on srs.service_style::text = v.style
         and srs.service_treatment_key::text = v.treatment_key
         and srs.shape = ${shape}::service_shape
    ),
    av_compat as (
      select c.room_type::text as room_type
        from service_room_type_compat c
        join av_variant v
          on c.service_style::text = v.style
         and c.service_treatment_key::text = v.treatment_key
    ),
    ${therapistPoolCtes(sql, poolQuery)}
    select
      (select epoch::text from availability_epoch where trading_date = ${request.tradingDate}) as epoch,
      (select coalesce(json_agg(json_build_object(
                'tradingDate', d.trading_date,
                'opensAt',  (extract(epoch from d.opens_at)  * 1000)::bigint,
                'closesAt', (extract(epoch from d.closes_at) * 1000)::bigint,
                'open',  d.open_time,
                'close', d.close_time
              ) order by d.trading_date), '[]'::json) from av_day d) as hours,
      (select json_build_object(
                'serviceVariantId', v.id,
                'durationMinutes', v.duration_minutes,
                'style', v.style,
                'treatmentKey', v.treatment_key,
                'turnaroundMinutes', v.turnaround_minutes,
                'requiredSkill', v.required_skill
              ) from av_variant v) as variant,
      (select json_build_object(
                'shape', s.shape,
                'therapistsRequired', s.therapists_required,
                'roomsRequired', s.rooms_required,
                'minRoomCapacity', s.min_room_capacity,
                'requiredRoomType', s.required_room_type,
                'therapistBufferMinutes', s.therapist_buffer_minutes
              ) from av_shape s) as shape,
      (select coalesce(json_agg(c.room_type order by c.room_type), '[]'::json)
         from av_compat c) as compat,
      (select coalesce(json_agg(json_build_object(
                'id', r.id::text,
                'roomType', r.room_type::text,
                'capacity', r.capacity,
                'isBookable', r.is_bookable
              ) order by r.display_order, r.code), '[]'::json)
         from rooms r
        -- Decommissioned rooms are dropped here, and this is the ONLY room predicate applied in SQL.
        -- bookableRoomsFor in @berelax/core refuses them unconditionally, so they are rows the consumer
        -- can never use. Room-type compatibility is deliberately NOT applied: that is a relation between
        -- the room and the SERVICE, shapeRoomTypes narrows it further by shape, and moving it here would
        -- be a second copy of a rule core owns. is_bookable is a property of the row itself.
        --
        -- No backticks in this string, on purpose: a backtick inside a JS template literal ENDS it, and
        -- the resulting statement parses as something else entirely. It cost a run to find.
        where r.is_bookable) as rooms,
      (select coalesce(json_agg(json_build_object(
                'roomId', b.room_id::text,
                'period', json_build_object(
                  'startsAt', (extract(epoch from lower(b.period)) * 1000)::bigint,
                  'endsAt',   (extract(epoch from upper(b.period)) * 1000)::bigint
                ),
                'kind', b.kind,
                'reason', b.reason
              ) order by lower(b.period), b.room_id), '[]'::json)
         from resource_block b
        where b.period && (select padded from av_window)) as blocks,
      -- The one scan this whole statement is measured on. The overlap operator is applied against an
      -- InitPlan scalar subquery rather than against a joined CTE, so it becomes an index qual on
      -- appointment_period_idx against a run-time constant instead of a join condition.
      (select coalesce(json_agg(json_build_object(
                'id', a.id::text,
                'roomId', a.room_id::text,
                'therapistId', a.therapist_id::text,
                'deliveryId', a.delivery_id::text,
                'roomPlaces', a.room_places,
                'startsAt', (extract(epoch from lower(a.period)) * 1000)::bigint,
                'endsAt',   (extract(epoch from upper(a.period)) * 1000)::bigint,
                'turnaroundMinutes', a.turnaround_minutes,
                'therapistBufferMinutes', a.therapist_buffer_minutes
              ) order by lower(a.period), a.room_id, a.therapist_id), '[]'::json)
         from appointment a
        where a.period && (select padded from av_window)
          and a.holds_resources) as appointments,
      (select coalesce(json_agg(json_build_object(
                'therapistId', p.employee_id::text,
                'gender', p.gender,
                'skills', p.skills,
                'reason', p.reason
              ) order by p.employee_id), '[]'::json) from tp_pool p) as pool,
      (select coalesce(json_agg(json_build_object(
                'therapistId', n.employee_id::text,
                'startsAt', (extract(epoch from n.starts_at) * 1000)::bigint,
                'endsAt',   (extract(epoch from n.ends_at)   * 1000)::bigint
              ) order by n.employee_id, n.starts_at), '[]'::json) from tp_presence n) as presence
  `
}

/**
 * The query plan of {@link readAvailabilityFacts}'s own statement, as `EXPLAIN (ANALYZE, FORMAT JSON)`.
 *
 * Exported for the assertion the acceptance list asks for and for nothing else. The plan is returned as
 * the parsed JSON PostgreSQL produced, unexamined: a helper here that decided "the index was used" would
 * be the second implementation of the thing under test, and the test would then be asserting against this
 * module's opinion of its own plan.
 *
 * ANALYZE, so the plan is the one that actually ran rather than the one the planner guessed. That means
 * the statement is EXECUTED — harmless for a read, and the reason this is not something to call from a
 * request path.
 */
export async function explainAvailabilityFacts(
  sql: Sql,
  request: AvailabilityRequest,
  now: number,
): Promise<unknown> {
  const rows = await sql<{ plan: unknown }[]>`
    explain (analyze, format json) ${availabilityFactsStatement(sql, request, now)}
  `
  // PostgreSQL names the column `QUERY PLAN`, and postgres.js hands it back under that exact key.
  return (rows[0] as Record<string, unknown> | undefined)?.['QUERY PLAN']
}

/**
 * Everything one request needs, in ONE round trip.
 *
 * The statement is {@link availabilityFactsStatement}; this awaits it and maps the JSON aggregates onto
 * the types the solver takes. `availability.itest.ts` asserts the round-trip count directly and asserts
 * the plan by index name out of `EXPLAIN (ANALYZE, FORMAT JSON)`, together with the ABSENCE of a
 * `Seq Scan` on `appointment` — a plan assertion that only checks the query returned rows proves nothing.
 */
export async function readAvailabilityFacts(
  sql: Sql,
  request: AvailabilityRequest,
  now: number,
): Promise<AvailabilityFacts> {
  const [row] = await availabilityFactsStatement(sql, request, now)

  const facts = row as FactsRow
  const hours = facts.hours ?? []
  const day = hours.find((entry) => entry.tradingDate === request.tradingDate) ?? null
  const pool = facts.pool ?? []
  const eligible = pool.filter((entry) => entry.reason === null)
  const eligibleIds = new Set(eligible.map((entry) => entry.therapistId))

  return {
    tradingDate: request.tradingDate,
    epoch: facts.epoch,
    hours,
    day,
    variant: facts.variant,
    shape:
      facts.shape === null
        ? null
        : {
            shape: facts.shape.shape,
            therapistsRequired: Number(facts.shape.therapistsRequired),
            roomsRequired: Number(facts.shape.roomsRequired),
            minRoomCapacity: Number(facts.shape.minRoomCapacity),
            // Spread rather than assigned: an explicit `undefined` is a different type from an absent
            // key under `exactOptionalPropertyTypes`, and absent is what "any compatible type" means.
            ...(facts.shape.requiredRoomType === null
              ? {}
              : { requiredRoomType: facts.shape.requiredRoomType }),
            therapistBufferMinutes: Number(facts.shape.therapistBufferMinutes),
          },
    compatibleRoomTypes: facts.compat ?? [],
    rooms: (facts.rooms ?? []).map((room) => ({
      id: room.id,
      roomType: room.roomType,
      capacity: Number(room.capacity),
      isBookable: room.isBookable,
    })),
    blocks: facts.blocks ?? [],
    appointments: (facts.appointments ?? []).map((appointment) => ({
      id: appointment.id,
      roomId: appointment.roomId,
      // One record per appointment ROW, with the delivery carried on each: each row blocks its own
      // therapist, and the ROOM is counted per delivery (0038). Merging rows here would report a Four
      // Hands as one therapist.
      therapistIds: [appointment.therapistId],
      delivery: { id: appointment.deliveryId, places: Number(appointment.roomPlaces) },
      treatment: { startsAt: Number(appointment.startsAt), endsAt: Number(appointment.endsAt) },
      turnaroundMinutes: Number(appointment.turnaroundMinutes),
      therapistBufferMinutes: Number(appointment.therapistBufferMinutes),
    })),
    therapists: eligible.map((entry) => ({
      therapistId: entry.therapistId,
      skills: entry.skills,
      ...(entry.gender === null ? {} : { gender: entry.gender }),
    })),
    // Presence only for therapists in the pool. An excluded therapist's roster is not availability, and
    // handing it to the solver alongside an id it was never given would make the two inputs disagree
    // about who the query was about.
    shifts: (facts.presence ?? [])
      .filter((entry) => eligibleIds.has(entry.therapistId))
      .map((entry) => ({
        therapistId: entry.therapistId,
        period: { startsAt: Number(entry.startsAt), endsAt: Number(entry.endsAt) },
      })),
    excluded: pool
      .filter((entry) => entry.reason !== null)
      .map((entry) => ({ therapistId: entry.therapistId, reason: entry.reason as string })),
  }
}

// ------------------------------------------------------------------------------------------------
// The injected rule
// ------------------------------------------------------------------------------------------------

/** Field for field `AvailabilityQueryFacts` in `@berelax/core`. See {@link AvailabilitySolve}. */
export interface AvailabilitySolveInput {
  readonly now: number
  readonly tradingDate: string
  readonly hours: Readonly<Record<string, { readonly open: string; readonly close: string }>>
  readonly closures: readonly { startsAt: number; endsAt: number; reason: string }[]
  readonly durationMinutes: number
  readonly turnaroundMinutes: number
  readonly minLeadMinutes: number
  readonly maxAdvanceDays: number
  readonly shape: AvailabilityShapeFacts
  readonly compatibleRoomTypes: readonly RoomTypeName[]
  readonly rooms: readonly AvailabilityRoomFacts[]
  readonly therapists: readonly AvailabilityTherapistFacts[]
  readonly shifts: readonly AvailabilityShiftFacts[]
  readonly appointments: readonly ScheduledAppointmentRow[]
  readonly blocks: readonly AvailabilityBlockFacts[]
  /**
   * The **client's** gender, or `undefined` when nobody asked.
   *
   * A required key with a possibly-undefined value, mirroring `AvailabilityQueryFacts` in `@berelax/core`:
   * "we did not collect it" has to be written out, so it is a statement at the call site rather than a
   * field somebody forgot. Under strict matching it is answered with `requires_client_gender`.
   */
  readonly clientGender: 'female' | 'male' | undefined
  readonly genderMatching?: string
  readonly stepMinutes?: number
}

export interface AvailabilitySlot {
  readonly startsAt: number
  readonly treatment: { readonly startsAt: number; readonly endsAt: number }
  readonly roomPeriod: { readonly startsAt: number; readonly endsAt: number }
  readonly therapistPeriod: { readonly startsAt: number; readonly endsAt: number }
  /** The room the assignment chose. One of {@link availableRoomIds}. */
  readonly roomId: string
  /** The therapists the assignment chose. A subset of {@link availableTherapistIds}. */
  readonly therapistIds: readonly string[]
  /**
   * Every room free for this start, not only the chosen one.
   *
   * A booking that takes the chosen room does NOT remove the start from availability while another room
   * is free, so "is this start still deliverable in that room" is a question only this set can answer.
   */
  readonly availableRoomIds: readonly string[]
  /**
   * Every therapist free for this start, after the gender rule — what the alternatives are counted from.
   *
   * The assignment reports the ONE it chose, which is the lowest id. Counting alternatives from that
   * would report one therapist however many were free, and the no-availability answer would name the
   * wrong person.
   */
  readonly availableTherapistIds: readonly string[]
  readonly placesUsed: number
  readonly genderMismatch: boolean
}

/** Field for field `AvailabilitySolvedDay` in `@berelax/core`. */
export interface AvailabilitySolveResult {
  readonly slots: readonly AvailabilitySlot[]
  readonly rejected: readonly { readonly startsAt: number; readonly reason: string }[]
  readonly refusal: string | null
  readonly windows: readonly { readonly startsAt: number; readonly endsAt: number }[]
  readonly excludedByGender: readonly { readonly therapistId: string; readonly reason: string }[]
}

/**
 * `solveAvailabilityQuery` from `@berelax/core`, injected.
 *
 * A function rather than an import because `packages/db` must never import `packages/core`. Required
 * rather than optional, and the refusal is `availability_not_solved`: a query that answered without it
 * would be a slot list nobody computed, which is the one failure a read path can cause a write to make.
 */
export type AvailabilitySolve = (input: AvailabilitySolveInput) => AvailabilitySolveResult

export interface AvailabilityDeps {
  readonly solve: AvailabilitySolve
  /** The memo. Absent means every request recomputes, which is correct and slower. */
  readonly cache?: AvailabilityCache
  /** The clock, as an instant. Injected so a frozen-clock test is possible at all. */
  readonly now?: number
  readonly ttlMs?: number
}

// ------------------------------------------------------------------------------------------------
// The memo
// ------------------------------------------------------------------------------------------------

export interface AvailabilityCacheEntry {
  readonly tag: string
  /** The epoch the answer was computed at, or null when the date had never been written to. */
  readonly epoch: string | null
  readonly computedAt: number
  readonly answer: AvailabilityAnswer
}

/**
 * The in-process memo. A `Map`, a TTL and nothing else.
 *
 * Not a table, and not shared between processes. `no-precomputed-slot-table` forbids the first and the
 * second is a decision: a memo that survives a deploy is a memo nobody can reason about, and the epoch
 * check makes cross-process coherence unnecessary — each process validates its own memo against the
 * number the database owns.
 */
export interface AvailabilityCache {
  readonly ttlMs: number
  get(tag: string): AvailabilityCacheEntry | undefined
  set(entry: AvailabilityCacheEntry): void
  delete(tag: string): void
  clear(): void
  readonly size: number
}

/**
 * A memo with a bounded TTL.
 *
 * A TTL above {@link MAX_AVAILABILITY_TTL_MS} is refused by name. Only that direction is refused: a
 * shorter memo costs a recomputation, and a longer one widens the window in which a caller holds a list
 * the epoch has not been consulted about. Zero is legal and means "validate every time", which is what
 * the purge assertions use.
 */
export function createAvailabilityCache(
  options: { readonly ttlMs?: number } = {},
): AvailabilityCache {
  const ttlMs = options.ttlMs ?? DEFAULT_AVAILABILITY_TTL_MS
  if (!Number.isInteger(ttlMs) || ttlMs < 0) {
    throw refusal(
      'validation',
      'availability_ttl_too_long',
      `a memo lifetime is whole non-negative milliseconds, got ${ttlMs}`,
      { ttlMs },
    )
  }
  if (ttlMs > MAX_AVAILABILITY_TTL_MS) {
    throw refusal(
      'validation',
      'availability_ttl_too_long',
      `${ttlMs}ms is longer than the ${MAX_AVAILABILITY_TTL_MS}ms this unit's band allows. The band is ` +
        '30-60 s and the default is the shorter end; a longer memo widens the window in which a caller ' +
        'holds a slot list the epoch has not been consulted about.',
      { ttlMs, maxTtlMs: MAX_AVAILABILITY_TTL_MS },
    )
  }
  const entries = new Map<string, AvailabilityCacheEntry>()
  return {
    ttlMs,
    get: (tag) => entries.get(tag),
    set: (entry) => {
      entries.set(entry.tag, entry)
    },
    delete: (tag) => {
      entries.delete(tag)
    },
    clear: () => entries.clear(),
    get size() {
      return entries.size
    },
  }
}

/**
 * The memo as it stands, **without validating it**. What a stale caller holds.
 *
 * Deliberately exported, and deliberately not a back door. A rendered booking page, a phone that went into
 * a pocket and a retry after a timeout are all callers holding a list nobody re-checked, and there has to
 * be a way to write the test that matters: prime the memo, commit a booking out of band, read the memo
 * back — it still offers the slot — and then book from it. `bookSlot` refuses with a named `slot_taken`,
 * because the booking transaction re-reads the committed rows under the room lock. If this were
 * unreachable, that test could only be written against a cache that had already been purged, which proves
 * the opposite of what it claims.
 */
export function peekAvailabilityCache(
  cache: AvailabilityCache,
  tag: string,
): AvailabilityCacheEntry | undefined {
  return cache.get(tag)
}

/** The current epochs for a set of trading dates. One round trip, one primary-key lookup per date. */
export async function readAvailabilityEpochs(
  sql: Sql,
  tradingDates: readonly string[],
): Promise<Map<string, string>> {
  if (tradingDates.length === 0) return new Map()
  const rows = await sql<{ trading_date: string; epoch: string }[]>`
    select trading_date::text as trading_date, epoch::text as epoch
      from availability_epoch
     where trading_date = any(${[...tradingDates]}::date[])
  `
  return new Map(rows.map((row) => [row.trading_date, row.epoch]))
}

/** What the last write to a trading date's availability was, for the four purge assertions. */
export async function readAvailabilityEpochRow(
  sql: Sql,
  tradingDate: string,
): Promise<{ readonly epoch: string; readonly lastCause: string } | null> {
  const [row] = await sql<{ epoch: string; last_cause: string }[]>`
    select epoch::text as epoch, last_cause::text as last_cause
      from availability_epoch where trading_date = ${tradingDate}
  `
  return row === undefined ? null : { epoch: row.epoch, lastCause: row.last_cause }
}

// ------------------------------------------------------------------------------------------------
// The answer
// ------------------------------------------------------------------------------------------------

export interface AvailabilityAnswer {
  readonly tradingDate: string
  readonly serviceVariantId: string
  readonly shape: ServiceShape
  /** The epoch the answer was computed at. A caller can re-validate it without re-reading the facts. */
  readonly epoch: string | null
  readonly computedAt: number
  readonly slots: readonly AvailabilitySlot[]
  readonly rejected: readonly { readonly startsAt: number; readonly reason: string }[]
  /**
   * Why the whole request could not be answered, or null. Never absent, so a caller cannot forget to
   * look — `requires_client_gender` under strict matching, and the three structural refusals below.
   */
  readonly refusal: string | null
  /**
   * The trading day's own span `[opens_at, closes_at)`, or null when the premises does not trade.
   *
   * Carried on the answer rather than left to a second read, and that is what lets
   * {@link noAvailabilityAlternatives} offer a waitlist window without asking the database again — a
   * window reconstructed from an opening time and a duration can disagree with the stored instants by a
   * minute, and `waitlist.trading_date` and `waitlist.desired_period` would then describe two days.
   */
  readonly window: { readonly startsAt: number; readonly endsAt: number } | null
  /** Every candidate the read model removed, with the reason it gave. Never a filtered silence. */
  readonly excluded: readonly { readonly therapistId: string; readonly reason: string }[]
  /** True when this answer came from the memo. A property of the read, not of the answer. */
  readonly cached: boolean
}

/**
 * Availability for one `(business_day, service_variant, therapist?)` request.
 *
 * One round trip on a miss, one on a hit, and the hit's round trip is a single primary-key lookup against
 * `availability_epoch`. A memo whose epoch no longer matches is dropped rather than served, which is what
 * makes "a write to appointment, shift, resource_block or approved leave purges the matching tag" a
 * property of the database rather than of whoever remembered to call a purge function.
 *
 * The structural refusals — `not_a_trading_date`, `variant_not_found`, `shape_not_offered`,
 * `no_compatible_room_type` — are returned as an answer with zero slots and a named `refusal`, not thrown.
 * "No availability" is what a booking page renders, and a thrown error there is a 500 where a sentence
 * belongs. `no_compatible_room_type` is the one that matters most: `service_room_type_compat` is
 * fail-closed by design (0012 — "structural absence is a loud failure; a fall-back is a quiet one"), and
 * an empty set means NO room rather than any room.
 */
export async function queryAvailability(
  sql: Sql,
  request: AvailabilityRequest,
  deps: AvailabilityDeps,
): Promise<AvailabilityAnswer> {
  // Fail closed, exactly as `createBooking` refuses a booking with no injected re-check. A slot list
  // produced without the rule is a slot list nobody computed.
  if (typeof deps?.solve !== 'function') {
    throw refusal(
      'invariant_violated',
      'availability_not_solved',
      'no solver was supplied, so nothing would have applied the availability rule. ' +
        '`solveAvailabilityQuery` from @berelax/core is the rule; packages/db may not import it, so ' +
        'the caller injects it.',
    )
  }
  const now = deps.now ?? Date.now()
  const shape = request.shape ?? 'solo'
  const tag = availabilityCacheTag(request)
  const cache = deps.cache
  const ttlMs = deps.ttlMs ?? cache?.ttlMs ?? DEFAULT_AVAILABILITY_TTL_MS

  if (cache !== undefined) {
    const held = cache.get(tag)
    if (held !== undefined) {
      const epochs = await readAvailabilityEpochs(sql, [request.tradingDate])
      const current = epochs.get(request.tradingDate) ?? null
      const fresh = now - held.computedAt < ttlMs
      if (fresh && held.epoch === current) {
        return { ...held.answer, cached: true }
      }
      // Dropped rather than left to expire. A tag whose epoch has moved is wrong for the rest of its
      // TTL, and leaving it in the map means the next caller pays the same lookup to reject it again.
      cache.delete(tag)
    }
  }

  const facts = await readAvailabilityFacts(sql, request, now)

  const answer = ((): AvailabilityAnswer => {
    const base = {
      tradingDate: request.tradingDate,
      serviceVariantId: request.serviceVariantId,
      shape,
      epoch: facts.epoch,
      computedAt: now,
      window:
        facts.day === null
          ? null
          : { startsAt: Number(facts.day.opensAt), endsAt: Number(facts.day.closesAt) },
      excluded: facts.excluded,
      cached: false,
    }
    const empty = (reason: AvailabilityRefusal): AvailabilityAnswer => ({
      ...base,
      slots: [],
      // No rejected starts either. No start was CONSIDERED, and inventing a list of them would suggest
      // the day was examined and found full — which is a different sentence and a different fix.
      rejected: [],
      refusal: reason,
    })

    if (facts.day === null) return empty('not_a_trading_date')
    if (facts.variant === null) return empty('variant_not_found')
    if (facts.shape === null) return empty('shape_not_offered')
    if (facts.compatibleRoomTypes.length === 0) return empty('no_compatible_room_type')

    const solved = deps.solve({
      now,
      tradingDate: request.tradingDate,
      hours: Object.fromEntries(
        facts.hours.map((entry) => [entry.tradingDate, { open: entry.open, close: entry.close }]),
      ),
      // Always empty from the database. A whole-day closure is ABSENT from `business_day` (0011) and an
      // intra-day one is a `resource_block` per room (0012), so no table produces a premises-wide
      // intra-day closure today. Passed explicitly rather than omitted, so the absence is a statement.
      closures: [],
      durationMinutes: facts.variant.durationMinutes,
      turnaroundMinutes: facts.variant.turnaroundMinutes,
      minLeadMinutes: request.minLeadMinutes,
      maxAdvanceDays: request.maxAdvanceDays,
      shape: facts.shape,
      compatibleRoomTypes: facts.compatibleRoomTypes,
      rooms: facts.rooms,
      therapists: facts.therapists,
      shifts: facts.shifts,
      appointments: facts.appointments,
      blocks: facts.blocks,
      // Written out rather than spread away: the solver's field is a REQUIRED key that may hold
      // undefined, so "the client's gender was never collected" cannot be reached by a caller forgetting
      // to mention it. Under strict matching that is the refusal, not the relaxation.
      clientGender: request.clientGender,
      ...(request.genderMatching === undefined ? {} : { genderMatching: request.genderMatching }),
      ...(request.stepMinutes === undefined ? {} : { stepMinutes: request.stepMinutes }),
    })

    return {
      ...base,
      slots: solved.slots,
      rejected: solved.rejected,
      refusal: solved.refusal,
      // The read model's exclusions plus the gender rule's, so the two cannot be reported separately by
      // two callers. The SQL already applied the gender rule, so `excludedByGender` is normally empty;
      // it is unioned rather than ignored because `narrowPoolByGender` re-applies the rule and a
      // provider that ignored the query's gender fields would be caught there and nowhere else.
      excluded: [...facts.excluded, ...solved.excludedByGender].filter(
        (row, index, all) =>
          all.findIndex(
            (other) => other.therapistId === row.therapistId && other.reason === row.reason,
          ) === index,
      ),
    }
  })()

  cache?.set({ tag, epoch: facts.epoch, computedAt: now, answer })
  return answer
}

// ------------------------------------------------------------------------------------------------
// The no-availability answer: structured, never a rendered sentence
// ------------------------------------------------------------------------------------------------

/**
 * A trading date near the one that was asked about, with how much it has.
 *
 * Structured, and every field is a value a caller formats: a trading date as `YYYY-MM-DD`, a count, an
 * instant in epoch milliseconds and a signed day offset. Not `"Thursday 3 October, 4 slots from 7pm"` —
 * that sentence has a locale, a time zone, a calendar and a plural rule baked into it, and an Arabic
 * caller, an ICS export and a JSON API each need a different one.
 */
export interface NearestDay {
  readonly tradingDate: string
  readonly slotCount: number
  /** The first offerable start on that date, in epoch milliseconds. */
  readonly firstStartsAt: number
  /** Signed trading dates from the date asked about. Negative is earlier. */
  readonly daysAway: number
}

/** A therapist with availability the request's own filter excluded. An id, never a name (ADR 0020). */
export interface AlternativeTherapist {
  readonly therapistId: string
  readonly slotCount: number
  readonly firstStartsAt: number
}

/**
 * Why a waitlist join is not on offer. Named, because "you cannot join" is not actionable.
 *
 * Five of the six are the query's own refusals, carried through rather than collapsed, so the reason a
 * join is refused is the same sentence the availability answer already gave. The sixth,
 * `slots_are_available`, is not a refusal at all: a day with space is not a day to wait for.
 *
 * `requires_client_gender` is here because a request that cannot be answered cannot be waited for
 * either — the gender has to be collected first, and a waitlist row filed without it would be offered a
 * slot the booking transaction then refuses with the same name.
 */
export const WAITLIST_INELIGIBILITY = [
  'not_a_trading_date',
  'variant_not_found',
  'shape_not_offered',
  'no_compatible_room_type',
  'requires_client_gender',
  'slots_are_available',
] as const
export type WaitlistIneligibility = (typeof WAITLIST_INELIGIBILITY)[number]

/**
 * Whether this request may join the waitlist, as data.
 *
 * A boolean plus the named reason it is false, plus the key a join would use. A bare `true`/`false` would
 * make the caller guess, and a rendered string would make the caller unable to act: the four fields under
 * `desiredWindow` are exactly the arguments {@link joinWaitlist} takes, so a UI can offer the join without
 * reassembling the request it has just been answered about.
 */
export interface WaitlistEligibility {
  readonly eligible: boolean
  readonly reason: WaitlistIneligibility | null
  readonly tradingDate: string
  readonly serviceVariantId: string
  readonly shape: ServiceShape
  readonly therapistId: string | null
  readonly desiredWindow: { readonly startsAt: number; readonly endsAt: number } | null
  /** True when this customer already holds a row for exactly this window. A repeat join is a no-op. */
  readonly alreadyWaiting: boolean
}

export interface NoAvailabilityAnswer {
  readonly tradingDate: string
  readonly nearestDays: readonly NearestDay[]
  readonly alternativeTherapists: readonly AlternativeTherapist[]
  readonly waitlistEligible: WaitlistEligibility
}

export interface AlternativesOptions {
  /** How many trading dates either side to examine. Bounded, because each one is a round trip. */
  readonly searchDays?: number
  /** The customer asking, so `alreadyWaiting` can be answered. Absent leaves it false. */
  readonly customerId?: string
}

/** Whole trading dates between two ISO dates. Negative when `to` is earlier. */
function isoDaysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

/**
 * The nearer trading dates that have space, nearest first.
 *
 * Outwards from the date asked about — one day earlier, one day later, two earlier, two later — so the
 * list is already in "nearest" order and a caller rendering *"the nearest day with space"* does not have
 * to sort. Each date is its own `(business_day, …)` request answered by the same single-statement read and
 * memoised under its own tag, which is why the bound matters: `searchDays` round trips, not one.
 */
async function nearestDaysWithSpace(
  sql: Sql,
  request: AvailabilityRequest,
  deps: AvailabilityDeps,
  searchDays: number,
): Promise<NearestDay[]> {
  const offsets: number[] = []
  for (let step = 1; step <= searchDays; step += 1) offsets.push(-step, step)

  const found: NearestDay[] = []
  for (const offset of offsets) {
    const tradingDate = shiftIsoDate(request.tradingDate, offset)
    const answer = await queryAvailability(sql, { ...request, tradingDate }, deps)
    const first = earliestStart(answer.slots)
    if (first === null) continue
    found.push({
      tradingDate,
      slotCount: answer.slots.length,
      firstStartsAt: first,
      daysAway: isoDaysBetween(request.tradingDate, tradingDate),
    })
  }
  // The offsets were generated nearest-first, and the sort states that rather than relying on it: a
  // future change to the generation order must not silently change the meaning of the list.
  return found.sort(
    (a, b) => Math.abs(a.daysAway) - Math.abs(b.daysAway) || a.daysAway - b.daysAway,
  )
}

/** The earliest offerable start, or null for an empty list. Never 0, which is a valid instant. */
function earliestStart(slots: readonly AvailabilitySlot[]): number | null {
  let earliest: number | null = null
  for (const slot of slots) {
    if (earliest === null || slot.startsAt < earliest) earliest = slot.startsAt
  }
  return earliest
}

/**
 * The same variant, on the same date, with the caller's therapist filter REMOVED.
 *
 * That is the only honest reading of "the same variant with other therapists": it re-asks the question the
 * caller narrowed. A therapist the caller already named is excluded from the result — they are not an
 * alternative to themselves, and listing them would read as *"try this therapist instead"*.
 *
 * When the caller named no therapist there is nothing to widen and the list is empty. That is the answer,
 * not a gap: the request was already about every therapist, so a non-empty list would be the same slots
 * the caller has just been told do not exist.
 */
async function therapistsOutsideTheFilter(
  sql: Sql,
  request: AvailabilityRequest,
  deps: AvailabilityDeps,
): Promise<AlternativeTherapist[]> {
  if (request.therapistIds === undefined) return []
  const named = new Set(request.therapistIds)
  const { therapistIds: _narrowed, ...widened } = request
  const wide = await queryAvailability(sql, widened, deps)

  const counted = new Map<string, { count: number; first: number }>()
  for (const slot of wide.slots) {
    // `availableTherapistIds` and NOT `therapistIds`. The assignment chose one therapist per start — the
    // lowest id — so counting the chosen one would report a single alternative however many were free,
    // and the answer would name the wrong person.
    for (const therapistId of slot.availableTherapistIds) {
      if (named.has(therapistId)) continue
      const held = counted.get(therapistId)
      counted.set(therapistId, {
        count: (held?.count ?? 0) + 1,
        first: held === undefined ? slot.startsAt : Math.min(held.first, slot.startsAt),
      })
    }
  }
  return [...counted.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([therapistId, row]) => ({
      therapistId,
      slotCount: row.count,
      firstStartsAt: row.first,
    }))
}

/**
 * Why a waitlist join is not on offer, or null.
 *
 * Every structural refusal the query itself produced is carried through by name rather than collapsed into
 * a bare `false`, and {@link waitlistIneligibilityFrom} **refuses** a refusal it does not know instead of
 * returning `undefined` — the same move `exclusionReasonFrom` makes, and for the same reason: a new refusal
 * added to the query and not to this list would present as "eligible" and put a row in the table for a
 * request that can never be satisfied.
 *
 * `slots_are_available` is the one reason that is not a refusal. A day with space is not a day to wait for:
 * without it the waitlist fills with people who could have booked, and the reader that offers a released
 * slot would offer it to them first.
 */
function waitlistIneligibilityFrom(answer: AvailabilityAnswer): WaitlistIneligibility | null {
  if (answer.refusal === null) {
    return answer.slots.length > 0 ? 'slots_are_available' : null
  }
  if ((WAITLIST_INELIGIBILITY as readonly string[]).includes(answer.refusal)) {
    return answer.refusal as WaitlistIneligibility
  }
  throw new AppError(
    'invariant_violated',
    `"${answer.refusal}" is not a waitlist ineligibility reason. AVAILABILITY_REFUSALS and ` +
      `WAITLIST_INELIGIBILITY have drifted; known reasons are ${WAITLIST_INELIGIBILITY.join(', ')}. ` +
      'Defaulting to "eligible" here would file a waitlist row for a request that can never be satisfied.',
    { details: { refusal: answer.refusal } },
  )
}

/**
 * The structured no-availability answer: nearer days, other therapists, and the waitlist.
 *
 * Deliberately a SEPARATE call from {@link queryAvailability} and deliberately more than one round trip. It
 * is the cold path — it runs when a day came back empty — and each nearby date is its own
 * `(business_day, …)` request with its own cache tag, answered by the same single-statement read. Folding
 * them into the main query would make every successful request pay for the failure case, and the acceptance
 * criterion the single round trip belongs to is about one `(business_day, service_variant, therapist?)`
 * request.
 *
 * Nothing here is a rendered string. `nearestDays` is a trading date, a count, an instant and a signed day
 * offset; `alternativeTherapists` is an id, a count and an instant; `waitlistEligible` is a boolean, a named
 * reason and the key a join would use. A sentence would carry a locale, a time zone, a calendar and a plural
 * rule, and the Arabic page, the JSON API and the ICS export each need a different one — so the caller
 * formats and this does not.
 */
export async function noAvailabilityAlternatives(
  sql: Sql,
  request: AvailabilityRequest,
  deps: AvailabilityDeps,
  options: AlternativesOptions = {},
): Promise<NoAvailabilityAnswer> {
  const searchDays = options.searchDays ?? DEFAULT_ALTERNATIVE_SEARCH_DAYS
  if (!Number.isInteger(searchDays) || searchDays < 1) {
    throw new AppError(
      'validation',
      `A no-availability search spans at least one trading date, got ${searchDays}`,
    )
  }

  // The date asked about, first. It is normally a cache hit — the caller is here BECAUSE it came back
  // empty — and it carries both the refusal and the trading window, so no second facts read is needed.
  const asked = await queryAvailability(sql, request, deps)
  const nearestDays = await nearestDaysWithSpace(sql, request, deps, searchDays)
  const alternativeTherapists = await therapistsOutsideTheFilter(sql, request, deps)

  // One named therapist is a therapist-specific waitlist entry; two or more is not a request any single
  // row can express, so it is filed as "any" rather than as the first of them. `null` is ONE key, because
  // `waitlist_one_row_per_window` is NULLS NOT DISTINCT.
  const therapistId =
    request.therapistIds !== undefined && request.therapistIds.length === 1
      ? (request.therapistIds[0] as string)
      : null
  const reason = waitlistIneligibilityFrom(asked)
  const desiredWindow = asked.window

  const alreadyWaiting =
    options.customerId === undefined || desiredWindow === null
      ? false
      : await waitlistHolds(sql, {
          customerId: options.customerId,
          serviceVariantId: request.serviceVariantId,
          tradingDate: request.tradingDate,
          window: desiredWindow,
          therapistId,
        })

  return {
    tradingDate: request.tradingDate,
    nearestDays,
    alternativeTherapists,
    waitlistEligible: {
      eligible: reason === null,
      reason,
      tradingDate: request.tradingDate,
      serviceVariantId: request.serviceVariantId,
      shape: request.shape ?? 'solo',
      therapistId,
      desiredWindow,
      alreadyWaiting,
    },
  }
}

// ------------------------------------------------------------------------------------------------
// The waitlist
// ------------------------------------------------------------------------------------------------

export interface WaitlistJoinInput {
  readonly customerId: string
  readonly serviceVariantId: string
  readonly tradingDate: string
  readonly window: { readonly startsAt: number; readonly endsAt: number }
  readonly shape?: ServiceShape
  /** The therapist asked for, or null for "any". Null is one key, not a new key per join. */
  readonly therapistId?: string | null
}

export interface WaitlistRow {
  readonly id: string
  readonly customerId: string
  readonly serviceVariantId: string
  readonly tradingDate: string
  readonly window: { readonly startsAt: number; readonly endsAt: number }
  readonly shape: ServiceShape
  readonly therapistId: string | null
  readonly createdAt: number
}

export interface WaitlistJoinResult {
  readonly waitlistId: string
  /** False when the row already existed. A repeat join is an idempotent no-op, never a second row. */
  readonly created: boolean
}

const iso = (epochMs: number): string => new Date(epochMs).toISOString()

/** True when this customer already holds a row for exactly this window. */
async function waitlistHolds(
  sql: Sql,
  args: {
    readonly customerId: string
    readonly serviceVariantId: string
    readonly tradingDate: string
    readonly window: { readonly startsAt: number; readonly endsAt: number }
    readonly therapistId: string | null
  },
): Promise<boolean> {
  const [row] = await sql<{ id: string }[]>`
    select id::text as id from waitlist
     where customer_id = ${args.customerId}
       and service_variant_id = ${args.serviceVariantId}
       and trading_date = ${args.tradingDate}
       and desired_period = ${`[${iso(args.window.startsAt)},${iso(args.window.endsAt)})`}::tstzrange
       and therapist_id is not distinct from ${args.therapistId}
  `
  return row !== undefined
}

/**
 * Joins the waitlist, idempotently.
 *
 * `on conflict … do nothing` against `waitlist_one_row_per_window`, then the existing row is returned. The
 * constraint is `UNIQUE NULLS NOT DISTINCT`, which is the whole of the claim: with PostgreSQL's default
 * `NULLS DISTINCT` two joins naming no therapist are two different keys, the conflict clause never fires,
 * and the table grows a row per page refresh. `waitlist_one_row_per_window` is named in
 * {@link availabilityError}, so a caller that composes its own INSERT gets the rule rather than a driver
 * message.
 *
 * An empty window is refused before a statement is issued. The database refuses it too
 * (`waitlist_period_nonempty`), and the refusal here is what names it as a request error rather than a
 * check violation arriving from a caller's own transaction.
 */
export async function joinWaitlist(
  sql: Sql,
  input: WaitlistJoinInput,
): Promise<WaitlistJoinResult> {
  if (input.window.endsAt <= input.window.startsAt) {
    throw refusal(
      'validation',
      'waitlist_window_empty',
      'a waiting window that ends at or before it starts accepts nothing while reading as a request ' +
        '(waitlist_period_nonempty). It would sit in the table looking like a waiting customer and ' +
        'never match a released slot.',
      { window: input.window },
    )
  }
  const shape = input.shape ?? 'solo'
  const therapistId = input.therapistId ?? null
  const period = `[${iso(input.window.startsAt)},${iso(input.window.endsAt)})`

  const inserted = await sql<{ id: string }[]>`
    insert into waitlist
      (customer_id, service_variant_id, trading_date, desired_period, shape, therapist_id)
    values (${input.customerId}, ${input.serviceVariantId}, ${input.tradingDate},
            ${period}::tstzrange, ${shape}::service_shape, ${therapistId})
    on conflict on constraint waitlist_one_row_per_window do nothing
    returning id::text as id
  `
  const created = inserted[0]
  if (created !== undefined) return { waitlistId: created.id, created: true }

  // `do nothing` returns no row, so the existing one is read back. Matched on the same five columns the
  // constraint covers, with `is not distinct from` for the therapist: `= null` is null, which matches
  // nothing, and the function would then report a row it had just declined to insert as missing.
  const [held] = await sql<{ id: string }[]>`
    select id::text as id from waitlist
     where customer_id = ${input.customerId}
       and service_variant_id = ${input.serviceVariantId}
       and trading_date = ${input.tradingDate}
       and desired_period = ${period}::tstzrange
       and therapist_id is not distinct from ${therapistId}
  `
  if (held === undefined) {
    throw new AppError(
      'invariant_violated',
      'The waitlist insert conflicted on waitlist_one_row_per_window and no row matching that key ' +
        'exists. The constraint and this read disagree about what the key is.',
      { details: { tradingDate: input.tradingDate, therapistId } },
    )
  }
  return { waitlistId: held.id, created: false }
}

/** A customer's waitlist rows, newest first. Ids only: a therapist has no display name here. */
export async function readWaitlistFor(
  sql: Sql,
  args: { readonly customerId: string },
): Promise<readonly WaitlistRow[]> {
  const rows = await sql<
    {
      id: string
      customer_id: string
      service_variant_id: string
      trading_date: string
      starts_at: Date
      ends_at: Date
      shape: ServiceShape
      therapist_id: string | null
      created_at: Date
    }[]
  >`
    select id::text as id, customer_id::text as customer_id,
           service_variant_id::text as service_variant_id, trading_date::text as trading_date,
           lower(desired_period) as starts_at, upper(desired_period) as ends_at,
           shape::text as shape, therapist_id::text as therapist_id, created_at
      from waitlist
     where customer_id = ${args.customerId}
     order by created_at desc, id desc
  `
  return rows.map((row) => ({
    id: row.id,
    customerId: row.customer_id,
    serviceVariantId: row.service_variant_id,
    tradingDate: row.trading_date,
    window: { startsAt: row.starts_at.getTime(), endsAt: row.ends_at.getTime() },
    shape: row.shape,
    therapistId: row.therapist_id,
    createdAt: row.created_at.getTime(),
  }))
}

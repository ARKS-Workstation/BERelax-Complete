import {
  AppError,
  type GenderMatchingMode,
  type RoomTypeName,
  type ServiceShape,
  type TherapistSkill,
} from '@berelax/shared'
import type { Actor, RequestContext } from '../audit.ts'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'
import { withUnitOfWork } from '../tx.ts'
import {
  type TransitionActor,
  type TransitionDecider,
  type TransitionDeps,
  type TransitionResult,
  transitionAppointment,
} from './appointment-transition.ts'
import {
  bookingError,
  bookingRefusalOf,
  lockRooms,
  type SlotRecheck,
  type SlotRecheckRoom,
  type SlotRecheckShape,
} from './create-booking.ts'
import { readCommittedAppointments, readEligibleTherapists } from './eligibility.ts'
import type { ScheduledStepMaintainer } from './scheduled-step.ts'

/**
 * The reschedule transaction (B-LIFE-03). The old period released and the new one acquired, or neither.
 *
 * ## Why a reschedule is two rows and not an UPDATE of one
 *
 * B-LIFE-01 decided this before this unit existed, in `packages/core/src/lifecycle/transitions.ts`:
 * `rescheduled` is a TERMINAL state whose repeat is refused, "because the appointment that still exists is
 * the SUCCESSOR". So the predecessor moves to `rescheduled` — which makes the generated column
 * `holds_resources` false (0024) and releases the therapist and the room in that one statement — and a new
 * row acquires the new period. The successor carries `rescheduled_from_id` (0049).
 *
 * The ORDER is load-bearing and it is the reason this cannot be one statement. `appointment_therapist_no_overlap`
 * is an immediate exclusion constraint, so inserting the successor while the predecessor still holds its
 * period refuses every reschedule that overlaps itself — which is most of them: moving a 19:00 treatment to
 * 19:30 is the commonest front-desk correction there is.
 *
 * ## The same locks, in the same order, as the booking transaction
 *
 * {@link lockRooms} is B-AVAIL-06's own function, imported rather than copied. Two writers of the same room
 * rows taking them in two orders deadlock, and a second implementation of "ascending room id" is a second
 * order waiting to diverge. The lock set here is the union of the rooms the delivery LEAVES and the room it
 * ARRIVES in, because both are written.
 *
 * The appointment rows are read under those locks and locked themselves; `transitionAppointment` takes
 * `SELECT … FOR UPDATE` on each row it moves. The room locks come first, always, and nothing in this build
 * takes an appointment row lock before a room lock — so there is no cycle to deadlock on.
 *
 * ## A reschedule moves the DELIVERY, not one row
 *
 * A Four Hands is two appointment rows over one client sharing a `delivery_id` (0038), and
 * `appointment_delivery_is_coherent` exists precisely because "a reschedule that moved one row of a Four
 * Hands would silently split it into two deliveries — two places, and the refusal would arrive at the next
 * booking rather than at the move". So every row of the delivery that still HOLDS its resources moves
 * together, into one new delivery id. Rows of the delivery that hold nothing — a half-cancelled Four Hands
 * — are left exactly as they are: they occupy no period, and rewriting them would be rewriting history.
 * That is the same reading the coherence trigger itself takes.
 *
 * ## The trading date is re-resolved, never derived
 *
 * Trading runs 11:00–02:00, so 01:30 belongs to the PREVIOUS trading date. `resolveTradingDate` from
 * `@berelax/core` is the rule and `packages/db` may not import it, so it arrives as an injected function
 * exactly as the slot re-check and the transition decider do. The `business_day` rows it needs are read
 * here, inside the transaction, bracketed by calendar date — a SUPERSET, because choosing the right row is
 * the rule and the rule is not this package's.
 *
 * ## What this does NOT do
 *
 * It does not re-price. A reschedule is the same sale at another time, so gross, net, VAT, the rate, the
 * price list and the promotion are copied from the predecessor, and so are `turnaround_minutes` and
 * `therapist_buffer_minutes` — the figures in force when the booking was TAKEN (0038). Re-reading the
 * catalogue here would let a turnaround the owner shortened this afternoon move the occupancy of a
 * treatment sold last week, which is the retroactive change 0038's own header warns about.
 *
 * It writes no `availability_epoch` row either. B-AVAIL-07's trigger (0045) advances the epoch of every
 * trading date an appointment write touches, OLD and NEW, so the cache invalidation is a consequence of
 * the write rather than a step this function performs — and the pair suite asserts that rather than
 * reimplementing it.
 */

/** Every reason this transaction refuses, as a value. Callers branch on these, never on prose. */
export const RESCHEDULE_REFUSALS = [
  /** No appointment with that id. */
  'appointment_not_found',
  /** No slot re-check was injected, so nothing re-applied the availability rule. Fail closed. */
  'slot_not_revalidated',
  /** No trading-date resolver was injected, so nothing re-resolved the business day. Fail closed. */
  'trading_date_not_resolved',
  /** The new start belongs to no trading date: the daytime gap, or a date the premises does not open. */
  'new_slot_outside_trading',
  /** A room this reschedule would write does not exist. */
  'room_not_found',
  /** The named therapists are not one per moving row. */
  'therapist_count_wrong',
  /** One therapist named twice is not two therapists. */
  'therapist_repeated',
  /** A named therapist may not take the appointment on the NEW trading date. */
  'therapist_not_eligible',
  /** The new period, room and therapists are all what the appointment already had. */
  'reschedule_changes_nothing',
  /** The room set changed under the unlocked read, so the locks do not cover what would be written. */
  'appointment_moved',
  /** The successor rows are not what was asked for. Read back, never assumed. */
  'successor_not_written',
  /** The new period ends at or before it starts. */
  'new_period_invalid',
  /** The footprint this appointment was sold in is no longer offered for the variant. */
  'shape_not_offered',
  /**
   * The new slot is not deliverable. The same name `createBooking` uses for the same fact, because it IS
   * the same fact — and `bookingError`, reused here, produces exactly this refusal from the therapist
   * exclusion constraint and the room capacity trigger.
   */
  'slot_taken',
  /** The rows of one delivery would disagree about the room, the period or the footprint (ZB004). */
  'delivery_incoherent',
  /** The premises does not trade on the resolved date, so `business_day` has no row for it. */
  'not_a_trading_date',
] as const
export type RescheduleRefusal = (typeof RESCHEDULE_REFUSALS)[number]

/** The `business_day` rows the resolver is handed. Field for field `TradingDayHoursRow` in core. */
export interface TradingDayHours {
  readonly tradingDate: string
  /** Local `HH:MM` in the business zone, as `at time zone 'Asia/Dubai'` produced it. */
  readonly open: string
  readonly close: string
}

/** What the injected resolver answers. Field for field `RescheduleTradingDate` in core. */
export type TradingDateResolution =
  | { readonly kind: 'trading'; readonly tradingDate: string }
  | { readonly kind: 'outside_trading'; readonly reason: string; readonly calendarDate: string }

/**
 * `rescheduleTradingDate` from `@berelax/core`, injected.
 *
 * A function rather than an import because `packages/db` must never import `packages/core`. Required
 * rather than optional: a reschedule that filed itself under a date nobody resolved is the 01:30 booking
 * landing on tomorrow's rota, tomorrow's cash-up and tomorrow's commission, and the permissive default
 * would be silent.
 */
export type TradingDateResolver = (input: {
  readonly startsAtMs: number
  readonly days: readonly TradingDayHours[]
}) => TradingDateResolution

/** The invalidation keys of the scheduled steps attached to an appointment, and whether they are readable. */
export interface ScheduledStepKeys {
  /**
   * False when `scheduled_step` does not exist yet.
   *
   * B-MSG-03 owns that table and is NOT built (`status: todo` in build/manifest.yaml). The distinction
   * matters more than the empty list does: "no steps are attached" and "nothing in this build schedules
   * anything" are different facts, and an event that reported the first while the second was true would
   * make a later reader believe the reminders had been considered.
   */
  readonly tablePresent: boolean
  readonly keys: readonly string[]
}

/** How the keys are read. Injected so a test can prove the payload carries what the reader FOUND. */
export type ScheduledStepKeyReader = (sql: Sql, appointmentId: string) => Promise<ScheduledStepKeys>

export interface RescheduleDeps {
  readonly decide: TransitionDecider
  readonly recheck: SlotRecheck
  readonly resolveTradingDate: TradingDateResolver
  /** Defaults to {@link readScheduledStepKeys}, which reads the real table when it exists. */
  readonly readScheduledStepKeys?: ScheduledStepKeyReader
  /**
   * B-MSG-03's scheduled-step maintainer, passed through to {@link transitionAppointment} and called a
   * SECOND time here, for the successor.
   *
   * Twice, because a reschedule is two different facts about two different rows. The predecessor moves to
   * `rescheduled` through the transition, so its pending steps are superseded by the same seam that
   * settles a cancellation. The successor is born by INSERT and never transitions into its status, so
   * nothing would ever build its reminder set — which would leave the customer with a moved appointment
   * and no reminders at all, a quieter failure than the one this unit is about and a failure all the same.
   */
  readonly steps?: ScheduledStepMaintainer
}

export interface RescheduleInput {
  /** Any appointment of the delivery being moved. Its whole delivery moves with it. */
  readonly appointmentId: string
  readonly actor: TransitionActor
  /** Mandatory: the transition table declares `rescheduled` `reasonRequired`, and the decider enforces it. */
  readonly reason: string
  /** The NEW treatment period, in epoch milliseconds. Turnaround and buffer are not baked in. */
  readonly treatment: { readonly startsAt: number; readonly endsAt: number }
  /** The new room. Defaults to the room the delivery is in now. */
  readonly roomId?: string
  /** One therapist per moving row. Defaults to the therapists it has now. */
  readonly therapistIds?: readonly string[]
  /** The client's gender, for the eligibility re-read. No table holds it (B-AVAIL-05). */
  readonly clientGender?: 'female' | 'male'
  /** `booking.same_gender_matching`. **Absent is strict**, as everywhere else. */
  readonly genderMatching?: GenderMatchingMode
}

/** One row moved: the predecessor, the successor it was replaced by, and the transition that did it. */
export interface RescheduledRow {
  readonly appointmentId: string
  readonly successorId: string
  readonly therapistId: string
  readonly transition: TransitionResult
}

export interface RescheduleResult {
  readonly bookingId: string
  /** The trading date the successor rows were filed under, as `resolveTradingDate` resolved it. */
  readonly tradingDate: string
  /** The trading date the predecessors were filed under. Different only across midnight. */
  readonly previousTradingDate: string
  /** The successors share this. A NEW id: one delivery is one room over one period (0038). */
  readonly deliveryId: string
  readonly roomId: string
  readonly rows: readonly RescheduledRow[]
  /** The steps whose keys the event carried, and whether the table they come from exists yet. */
  readonly scheduledSteps: ScheduledStepKeys
}

const refusal = (
  kind: 'conflict' | 'validation' | 'invariant_violated' | 'not_found',
  name: RescheduleRefusal,
  message: string,
  extra: Record<string, unknown> = {},
): AppError =>
  new AppError(kind, `${name}: ${message}`, {
    userFacing: true,
    details: { refusal: name, ...extra },
  })

/** The refusal an error carries, or `null`. Lets a caller branch without matching on the message. */
export function rescheduleRefusalOf(err: unknown): RescheduleRefusal | null {
  // Translated the same way `bookingRefusalOf` does it, because a constraint this transaction violates
  // arrives as a SQLSTATE and the caller should not have to know which of the two vocabularies named it.
  const own = err instanceof AppError ? err.details['refusal'] : undefined
  const name = own ?? bookingRefusalOf(err)
  return RESCHEDULE_REFUSALS.includes(name as RescheduleRefusal)
    ? (name as RescheduleRefusal)
    : null
}

interface DeliveryRow {
  readonly id: string
  readonly booking_id: string
  readonly delivery_id: string
  readonly room_id: string
  readonly therapist_id: string
  readonly status: string
  readonly trading_date: string
  readonly starts_at: Date
  readonly ends_at: Date
  readonly holds_resources: boolean
  readonly service_variant_id: string
  readonly shape: string
  readonly room_places: number
  readonly turnaround_minutes: number
  readonly therapist_buffer_minutes: number
  readonly gross_price_fils: string
  readonly net_fils: string
  readonly vat_fils: string
  readonly vat_rate_bp: number
  readonly price_list_id: string | null
  readonly promotion_id: string | null
}

/** The ISO instant a `tstzrange` bound is built from. The zone is UTC and always written out. */
const iso = (epochMs: number): string => new Date(epochMs).toISOString()

/** A period as DATA — two instants — rather than as the `[a,b)` string a range renders to. */
const periodOf = (startsAt: number, endsAt: number) => ({
  starts_at: iso(startsAt),
  ends_at: iso(endsAt),
})

/**
 * The invalidation keys of every scheduled step attached to an appointment.
 *
 * **`scheduled_step` does not exist yet.** B-MSG-03 owns it and is `status: todo`, so this reader asks
 * whether the table AND the two columns it needs are there before it selects anything — a statement naming
 * a missing relation fails at PARSE time and aborts the transaction it arrived in, which would turn "the
 * reminders unit is not built" into "the reschedule is broken".
 *
 * It is written this way rather than left out because the acceptance criterion is about the event carrying
 * the keys of the steps that ARE there. Today that is an empty list against a table that does not exist,
 * and the event says so (`scheduled_step_table: 'absent'`). The day B-MSG-03 lands with
 * `scheduled_step (appointment_id, invalidation_key)`, this starts returning its rows with no change here —
 * and `appointment-reschedule.itest.ts` asserts the key list against the rows actually present rather than
 * asserting non-empty against nothing, which is the assertion that would have to be faked today.
 */
export async function readScheduledStepKeys(
  sql: Sql,
  appointmentId: string,
): Promise<ScheduledStepKeys> {
  const [probe] = await sql<{ present: boolean }[]>`
    select (
      to_regclass('public.scheduled_step') is not null
      and (select count(*) = 2
             from information_schema.columns
            where table_schema = 'public'
              and table_name = 'scheduled_step'
              and column_name in ('appointment_id', 'invalidation_key'))
    ) as present
  `
  if (probe?.present !== true) return { tablePresent: false, keys: [] }
  const rows = await sql<{ invalidation_key: string }[]>`
    select invalidation_key
      from scheduled_step
     where appointment_id = ${appointmentId}
     order by invalidation_key
  `
  return { tablePresent: true, keys: rows.map((row) => row.invalidation_key) }
}

/**
 * The rows of the delivery this appointment belongs to, locked, plus the catalogue facts the re-check needs.
 *
 * One statement, `for update`. The rows of one delivery are only ever written by a transaction holding the
 * room locks taken above, so the order they are locked in within the delivery cannot deadlock against
 * another writer — the ORDERED locks are the room rows, which is where the rule lives.
 */
async function lockDeliveryRows(
  uow: UnitOfWork,
  deliveryId: string,
): Promise<readonly DeliveryRow[]> {
  return await uow.sql<DeliveryRow[]>`
    select a.id::text as id,
           a.booking_id::text as booking_id,
           a.delivery_id::text as delivery_id,
           a.room_id::text as room_id,
           a.therapist_id::text as therapist_id,
           a.status::text as status,
           a.trading_date::text as trading_date,
           lower(a.period) as starts_at,
           upper(a.period) as ends_at,
           a.holds_resources,
           a.service_variant_id::text as service_variant_id,
           a.shape::text as shape,
           a.room_places,
           a.turnaround_minutes,
           a.therapist_buffer_minutes,
           a.gross_price_fils::text as gross_price_fils,
           a.net_fils::text as net_fils,
           a.vat_fils::text as vat_fils,
           a.vat_rate_bp,
           a.price_list_id::text as price_list_id,
           a.promotion_id
      from appointment a
     where a.delivery_id = ${deliveryId}
     order by a.id
       for update
  `
}

interface ShapeFactsRow {
  readonly rooms_required: number
  readonly required_room_type: RoomTypeName | null
  readonly required_skill: TherapistSkill
}

/**
 * The two catalogue facts the re-check needs that the appointment does not snapshot.
 *
 * `required_room_type` and `rooms_required` are rules about which room may deliver the treatment, not
 * figures that were sold, so today's catalogue is the right source: a treatment that is no longer offered
 * in a standard room must not be moved into one. Everything else the re-check needs comes from the
 * appointment's own snapshot — the buffer, the places and the shape — because those were priced and
 * promised (0038).
 */
async function readShapeFacts(
  uow: UnitOfWork,
  args: { readonly serviceVariantId: string; readonly shape: string },
): Promise<ShapeFactsRow> {
  const [row] = await uow.sql<ShapeFactsRow[]>`
    select srs.rooms_required,
           srs.required_room_type::text as required_room_type,
           sk.required_skill::text as required_skill
      from service_variant v
      join service s on s.id = v.service_id
      join service_skill sk on sk.style = s.style
      join service_resource_shape srs
        on srs.service_style = s.style
       and srs.service_treatment_key = s.treatment_key
       and srs.shape = ${args.shape}::service_shape
     where v.id = ${args.serviceVariantId}
  `
  if (row === undefined) {
    // Reachable only if the footprint was withdrawn from the catalogue after the booking was taken. The
    // slot cannot be re-checked against a footprint nobody offers, and guessing one would move the
    // appointment into a room the service is no longer sold in.
    throw refusal(
      'conflict',
      'shape_not_offered',
      `no service_resource_shape row offers the ${args.shape} footprint for this variant any more, so ` +
        'the new slot cannot be re-checked against the footprint that was sold',
      { serviceVariantId: args.serviceVariantId, shape: args.shape },
    )
  }
  return row
}

/**
 * The `business_day` rows that could contain an instant, bracketed by calendar date.
 *
 * A SUPERSET on purpose: WHICH of them contains the instant is `resolveTradingDate`'s rule, and this
 * package may not own it. The bracket is ±1 calendar date around the instant's own Dubai date, which is
 * every row the resolver consults (it asks about the instant's calendar date and the one before it) plus
 * one; the conversion is `at time zone 'Asia/Dubai'` in SQL rather than a second timezone calculation
 * here.
 */
async function readCandidateDays(
  uow: UnitOfWork,
  startsAtMs: number,
): Promise<readonly TradingDayHours[]> {
  const rows = await uow.sql<{ trading_date: string; open_time: string; close_time: string }[]>`
    select trading_date::text as trading_date,
           to_char(opens_at  at time zone 'Asia/Dubai', 'HH24:MI') as open_time,
           to_char(closes_at at time zone 'Asia/Dubai', 'HH24:MI') as close_time
      from business_day
     where trading_date between
             ((${iso(startsAtMs)}::timestamptz at time zone 'Asia/Dubai')::date - 1)
         and ((${iso(startsAtMs)}::timestamptz at time zone 'Asia/Dubai')::date + 1)
     order by trading_date
  `
  return rows.map((row) => ({
    tradingDate: row.trading_date,
    open: row.open_time,
    close: row.close_time,
  }))
}

/** `n` fresh v7 uuids, from the database's own generator. v4 here would break the id ordering 0024 chose. */
async function freshIds(uow: UnitOfWork, n: number): Promise<readonly string[]> {
  const rows = await uow.sql<{ id: string }[]>`
    select uuid_generate_v7()::text as id from generate_series(1, ${n})
  `
  return rows.map((row) => row.id)
}

/**
 * Re-applies B-AVAIL-04's eligibility read model on the NEW trading date.
 *
 * The rule is `readEligibleTherapists` — the same reader `createBooking` narrows, so this is not a second
 * implementation of "is this therapist bookable". What differs is the date: a therapist who was rostered
 * for Thursday is not necessarily rostered for Friday, may be on approved leave, and may hold a licence
 * that lapses in between. A reschedule that skipped this would place an appointment with a therapist the
 * availability query would refuse to offer — the hole `appointment.therapist_id`'s absent foreign key
 * cannot close.
 */
async function assertTherapistsAreEligible(
  uow: UnitOfWork,
  args: {
    readonly tradingDate: string
    readonly therapistIds: readonly string[]
    readonly requiredSkill: TherapistSkill
    readonly clientGender?: 'female' | 'male'
    readonly genderMatching?: GenderMatchingMode
  },
): Promise<void> {
  const pool = await readEligibleTherapists(uow.sql, {
    tradingDate: args.tradingDate,
    requiredSkill: args.requiredSkill,
    employeeIds: args.therapistIds,
    ...(args.clientGender === undefined ? {} : { clientGender: args.clientGender }),
    ...(args.genderMatching === undefined ? {} : { genderMatching: args.genderMatching }),
  })
  const eligible = new Set(pool.therapists.map((therapist) => therapist.therapistId))
  const ineligible = args.therapistIds.filter((id) => !eligible.has(id))
  if (ineligible.length === 0) return
  throw refusal(
    'conflict',
    'therapist_not_eligible',
    `${ineligible.length} of the named therapists may not take this appointment on ${args.tradingDate}. ` +
      'A roster, an approved leave request and a licence expiry all differ by date, so the eligibility ' +
      'read model is re-applied against the trading date the appointment is MOVING to.',
    {
      tradingDate: args.tradingDate,
      ineligible,
      excluded: pool.excluded.filter((row) => ineligible.includes(row.therapistId)),
    },
  )
}

/** The rows that still hold resources, plus the target row whatever its state. See the header. */
function rowsToMove(rows: readonly DeliveryRow[], appointmentId: string): readonly DeliveryRow[] {
  return rows.filter((row) => row.holds_resources || row.id === appointmentId)
}

/** True when the move would change neither the period, nor the room, nor who is delivering it. */
function changesNothing(
  rows: readonly DeliveryRow[],
  args: {
    readonly roomId: string
    readonly therapistIds: readonly string[]
    readonly treatment: { readonly startsAt: number; readonly endsAt: number }
  },
): boolean {
  const samePeriod = rows.every(
    (row) =>
      row.starts_at.getTime() === args.treatment.startsAt &&
      row.ends_at.getTime() === args.treatment.endsAt,
  )
  const sameRoom = rows.every((row) => row.room_id === args.roomId)
  const before = [...rows.map((row) => row.therapist_id)].sort()
  const after = [...args.therapistIds].sort()
  const sameTherapists =
    before.length === after.length && before.every((id, index) => id === after[index])
  return samePeriod && sameRoom && sameTherapists
}

/**
 * Asserts the successors exist, hold their resources and are filed under the resolved trading date.
 *
 * Read back rather than assumed, the same reason `transitionAppointment` reads its history row back: a
 * reschedule that released a period without acquiring one is a slot the salon cannot sell and cannot see,
 * and the successor's own INSERT returning cleanly does not prove the generated `holds_resources` came out
 * true or that the date the row landed on is the one that was resolved.
 */
async function assertSuccessorsWereWritten(
  uow: UnitOfWork,
  args: { readonly predecessorIds: readonly string[]; readonly tradingDate: string },
): Promise<void> {
  const [check] = await uow.sql<{ n: string; holding: string; dates: string[] }[]>`
    select count(*)::text as n,
           count(*) filter (where holds_resources)::text as holding,
           coalesce(array_agg(distinct trading_date::text), '{}'::text[]) as dates
      from appointment
     where rescheduled_from_id = any(${args.predecessorIds}::uuid[])
  `
  const expected = args.predecessorIds.length
  const correct =
    check !== undefined &&
    Number(check.n) === expected &&
    Number(check.holding) === expected &&
    check.dates.length === 1 &&
    check.dates[0] === args.tradingDate
  if (correct) return
  throw refusal(
    'invariant_violated',
    'successor_not_written',
    `${check?.n ?? '0'} successor row(s) exist for ${expected} predecessor(s), ` +
      `${check?.holding ?? '0'} of them holding resources, on trading date(s) ` +
      `${JSON.stringify(check?.dates ?? [])}. A reschedule that released a period without acquiring ` +
      'one is a slot the salon cannot sell and cannot see.',
    { expected, stored: check?.n, tradingDate: args.tradingDate },
  )
}

/**
 * The therapists the successors will hold, once the arguments have been checked against the delivery.
 *
 * Three refusals, each of which the database would otherwise raise later and less helpfully: a count that
 * does not match the rows would split the delivery (ZB004 at COMMIT), a repeated therapist meets
 * `appointment_therapist_no_overlap` on the second insert, and a move that changes nothing is refused
 * outright — it would still supersede a row and write another, so the chain would record a move that did
 * not happen. The likeliest cause of the third is a drag on the calendar that snapped back.
 */
function assertTherapistsFitTheDelivery(
  input: RescheduleInput,
  moving: readonly DeliveryRow[],
  newRoomId: string,
): readonly string[] {
  const therapistIds = input.therapistIds ?? moving.map((row) => row.therapist_id)
  if (therapistIds.length !== moving.length) {
    throw refusal(
      'validation',
      'therapist_count_wrong',
      `this delivery is ${moving.length} appointment row(s) and ${therapistIds.length} therapist(s) ` +
        'were named. Dropping the extra one would split the delivery, which is what ' +
        'appointment_delivery_is_coherent refuses at COMMIT.',
      { rows: moving.length, named: therapistIds.length },
    )
  }
  if (new Set(therapistIds).size !== therapistIds.length) {
    throw refusal(
      'validation',
      'therapist_repeated',
      'a pair that is one therapist listed twice is not two therapists, and ' +
        'appointment_therapist_no_overlap refuses the second row',
      { therapistIds: [...therapistIds] },
    )
  }
  if (changesNothing(moving, { roomId: newRoomId, therapistIds, treatment: input.treatment })) {
    throw refusal(
      'validation',
      'reschedule_changes_nothing',
      'the new period, room and therapists are the ones the appointment already has, so there is ' +
        'nothing to move. A reschedule supersedes a row and creates another; recording one for a move ' +
        'that did not happen makes the chain read as activity.',
      { appointmentId: input.appointmentId },
    )
  }
  return therapistIds
}

/**
 * Everything refused before a statement is issued: the two injected rules, and the period itself.
 *
 * Fail closed on both. Each is a rule this package does not own, and a reschedule written without one is a
 * reschedule nobody checked — the same shape `createBooking` takes for its re-check and
 * `transitionAppointment` for its decider. `decide` is checked by `transitionAppointment` itself, which is
 * where its refusal is named.
 */
function assertRequestIsWellFormed(input: RescheduleInput, deps: RescheduleDeps): void {
  if (typeof deps?.recheck !== 'function') {
    throw refusal(
      'invariant_violated',
      'slot_not_revalidated',
      'no slot re-check was supplied, so nothing re-applied the availability rule to the new period. ' +
        '`recheckShapeAssignment` from @berelax/core is the rule; packages/db may not import it, so the ' +
        'caller injects it.',
    )
  }
  if (typeof deps?.resolveTradingDate !== 'function') {
    throw refusal(
      'invariant_violated',
      'trading_date_not_resolved',
      'no trading-date resolver was supplied. Trading runs 11:00-02:00, so 01:30 belongs to the ' +
        'PREVIOUS trading date and no arithmetic on a calendar date gets that right; ' +
        '`rescheduleTradingDate` from @berelax/core is the rule and the caller injects it.',
    )
  }
  if (input.treatment.endsAt <= input.treatment.startsAt) {
    // `appointment_period_upper_after_lower` would refuse it, and the refusal would arrive from an INSERT
    // several statements later with a constraint name instead of the argument that was wrong.
    throw refusal(
      'validation',
      'new_period_invalid',
      'the new period ends at or before it starts, so it is not a period the appointment could be ' +
        'moved into',
      { treatment: input.treatment },
    )
  }
}

/**
 * Moves one delivery to a new period inside an existing unit of work. All of it, or none of it.
 *
 * Call it through {@link rescheduleAppointmentTx} unless the move is part of a larger transaction.
 */
export async function rescheduleAppointment(
  uow: UnitOfWork,
  input: RescheduleInput,
  deps: RescheduleDeps,
): Promise<RescheduleResult> {
  assertRequestIsWellFormed(input, deps)

  // UNLOCKED, and only to compute the lock set: which delivery, and which room it is in now. Every value
  // a decision is made from is re-read below under the locks. If the room set has changed in between, the
  // locks do not cover what would be written and the transaction refuses rather than proceeding.
  const [target] = await uow.sql<{ delivery_id: string; room_id: string }[]>`
    select delivery_id::text as delivery_id, room_id::text as room_id
      from appointment where id = ${input.appointmentId}
  `
  if (target === undefined) {
    throw refusal(
      'not_found',
      'appointment_not_found',
      `no appointment with id ${input.appointmentId}`,
      { appointmentId: input.appointmentId },
    )
  }

  const newRoomId = input.roomId ?? target.room_id
  // The union of the rooms this delivery LEAVES and the one it ARRIVES in, de-duplicated and SORTED. The
  // sort is the deadlock-avoidance rule and it is here, at the call site, for the reason `createBooking`
  // gives: it is a property of the request rather than of the query.
  const roomIds = [...new Set([target.room_id, newRoomId])].sort()
  const locked = await lockRooms(uow.sql, roomIds)
  for (const roomId of roomIds) {
    if (!locked.some((room) => room.id === roomId)) {
      throw refusal('validation', 'room_not_found', `no room with id ${roomId}`, { roomId })
    }
  }

  // Read AFTER the locks. Under READ COMMITTED this is the first statement that can see a competitor's
  // committed reschedule of the same delivery, and seeing it is the whole purpose of having waited.
  const deliveryRows = await lockDeliveryRows(uow, target.delivery_id)
  const moving = rowsToMove(deliveryRows, input.appointmentId)
  const first = moving[0]
  if (first === undefined) {
    throw refusal(
      'not_found',
      'appointment_not_found',
      `appointment ${input.appointmentId} is no longer part of delivery ${target.delivery_id}`,
      { appointmentId: input.appointmentId, deliveryId: target.delivery_id },
    )
  }
  if (moving.some((row) => !roomIds.includes(row.room_id))) {
    throw refusal(
      'conflict',
      'appointment_moved',
      'the delivery is in a room this transaction did not lock, so another writer moved it between the ' +
        'read that computed the lock set and the locks themselves. Proceeding would write rows into an ' +
        'unlocked room, which is the one thing the lock exists to prevent.',
      { locked: roomIds, found: [...new Set(moving.map((row) => row.room_id))] },
    )
  }

  const therapistIds = assertTherapistsFitTheDelivery(input, moving, newRoomId)

  // The trading date, re-resolved through core's rule from the rows read here.
  const resolution = deps.resolveTradingDate({
    startsAtMs: input.treatment.startsAt,
    days: await readCandidateDays(uow, input.treatment.startsAt),
  })
  if (resolution.kind !== 'trading') {
    throw refusal(
      'validation',
      'new_slot_outside_trading',
      `the new start belongs to no trading date (${resolution.reason}). Trading runs 11:00-02:00 and ` +
        'the calendar is a table (0011), not a rule: an appointment filed under a date the premises ' +
        'does not trade has no rota, no cash-up and no commission to belong to.',
      { reason: resolution.reason, calendarDate: resolution.calendarDate },
    )
  }
  const tradingDate = resolution.tradingDate

  const shapeFacts = await readShapeFacts(uow, {
    serviceVariantId: first.service_variant_id,
    shape: first.shape,
  })
  await assertTherapistsAreEligible(uow, {
    tradingDate,
    therapistIds,
    requiredSkill: shapeFacts.required_skill,
    ...(input.clientGender === undefined ? {} : { clientGender: input.clientGender }),
    ...(input.genderMatching === undefined ? {} : { genderMatching: input.genderMatching }),
  })

  const room = locked.find((candidate) => candidate.id === newRoomId) as SlotRecheckRoom
  const stepReader = deps.readScheduledStepKeys ?? readScheduledStepKeys
  const transitionDeps = transitionDepsFrom(deps)
  const successorIds = await freshIds(uow, moving.length + 1)
  const deliveryId = successorIds[moving.length] as string

  // Every predecessor is released FIRST. `appointment_therapist_no_overlap` is immediate, so a successor
  // inserted while its predecessor still holds the period would be refused for overlapping ITSELF — and
  // moving a 19:00 treatment to 19:30 is the commonest correction the front desk makes.
  const moved: RescheduledRow[] = []
  const previousTradingDate = first.trading_date
  let scheduledSteps: ScheduledStepKeys = { tablePresent: false, keys: [] }
  for (const [index, row] of moving.entries()) {
    const successorId = successorIds[index] as string
    const steps = await stepReader(uow.sql, row.id)
    // Each EVENT carries this row's own keys, because a scheduled step belongs to one appointment and the
    // event is per appointment. The RESULT carries the union across the delivery, because the caller is
    // moving one delivery and the set it has to invalidate is every step the delivery had attached.
    scheduledSteps = {
      tablePresent: steps.tablePresent,
      keys: [...new Set([...scheduledSteps.keys, ...steps.keys])].sort(),
    }
    const transition = await transitionAppointment(
      uow,
      {
        appointmentId: row.id,
        to: 'rescheduled',
        actor: input.actor,
        reason: input.reason,
        // The facts only this transaction knows. `snake_case`, because the same object is written into
        // `audit_event.after` (0005's spelling) as well as into the outbox payload. Periods are two
        // instants rather than a rendered `[a,b)` string: a caller reading a period out of a payload must
        // not have to parse a range literal.
        extra: {
          old_period: periodOf(row.starts_at.getTime(), row.ends_at.getTime()),
          new_period: periodOf(input.treatment.startsAt, input.treatment.endsAt),
          old_trading_date: row.trading_date,
          new_trading_date: tradingDate,
          old_room_id: row.room_id,
          new_room_id: newRoomId,
          successor_appointment_id: successorId,
          successor_delivery_id: deliveryId,
          scheduled_step_invalidation_keys: steps.keys,
          // 'absent' is a fact, not a shrug: B-MSG-03 owns `scheduled_step` and is not built, so a
          // reader of this event can tell "no reminders were attached" from "nothing in this build
          // schedules reminders yet".
          scheduled_step_table: steps.tablePresent ? 'present' : 'absent',
        },
      },
      transitionDeps,
    )
    if (transition.kind !== 'transitioned') {
      // `rescheduled` declares its repeat REFUSED, so the decider answers `already_in_status` rather than
      // a no-op and this branch is unreachable through it. It stays because a no-op here would mean the
      // period was never released and the successor below would be refused for overlapping it — a
      // failure whose message would be about a therapist clash rather than about this.
      throw refusal(
        'invariant_violated',
        'successor_not_written',
        `the transition of ${row.id} to rescheduled was a no-op, so its period was never released`,
        { appointmentId: row.id },
      )
    }
    moved.push({
      appointmentId: row.id,
      successorId,
      therapistId: therapistIds[index] as string,
      transition,
    })
  }

  // Now the period is free, so the re-check sees what a new booking would see: the committed rows of the
  // NEW trading date, which no longer include the ones just released.
  const committed = await readCommittedAppointments(uow.sql, { tradingDate })
  const shape: SlotRecheckShape = {
    shape: first.shape as ServiceShape,
    // The rows this delivery actually has, not today's `therapists_required`: a delivery whose second row
    // was cancelled is one row, and demanding two would refuse a move the salon can deliver.
    therapistsRequired: moving.length,
    roomsRequired: Number(shapeFacts.rooms_required),
    // The SNAPSHOT (0038). The places this delivery was sold as, not the figure the catalogue holds today.
    minRoomCapacity: Number(first.room_places),
    ...(shapeFacts.required_room_type === null
      ? {}
      : { requiredRoomType: shapeFacts.required_room_type }),
    therapistBufferMinutes: Number(first.therapist_buffer_minutes),
  }
  const verdict = deps.recheck({
    shape,
    // Only the room that was asked for. The question is "is this tuple deliverable at the new time", not
    // "find me a room": moving the booking to a room nobody mentioned changes what the customer was told.
    rooms: [room],
    therapistIds,
    treatment: input.treatment,
    appointments: committed,
  })
  if (verdict.kind === 'refused') {
    throw refusal(
      'conflict',
      'slot_taken',
      `the new slot is not available (${verdict.reason}). The old period has been released inside this ` +
        'transaction and this refusal rolls the release back with everything else, so the appointment ' +
        'keeps the slot it had.',
      { reason: verdict.reason, roomId: newRoomId, shape: first.shape },
    )
  }

  // One successor per moving row, in the same order, sharing the new delivery id. The therapist is the
  // one the caller named rather than `verdict.therapistIds`: the two are the same SET by construction —
  // `assignShape` de-duplicates and slices to `therapistsRequired`, and both were checked above — and
  // keeping the caller's order keeps each row paired with the therapist the front desk assigned to it.
  for (const [index, row] of moving.entries()) {
    await uow.sql`
      insert into appointment (
        id, booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
        delivery_id, room_places, turnaround_minutes, therapist_buffer_minutes,
        gross_price_fils, net_fils, vat_fils, vat_rate_bp, price_list_id, promotion_id,
        rescheduled_from_id
      ) values (
        ${successorIds[index] as string},
        ${row.booking_id},
        ${tradingDate}::date,
        ${row.service_variant_id},
        ${row.shape}::service_shape,
        ${therapistIds[index] as string},
        ${newRoomId},
        ${`[${iso(input.treatment.startsAt)},${iso(input.treatment.endsAt)})`}::tstzrange,
        ${successorStatus(row.status)}::appointment_status,
        ${deliveryId},
        ${verdict.placesUsed},
        ${row.turnaround_minutes},
        ${row.therapist_buffer_minutes},
        ${row.gross_price_fils},
        ${row.net_fils},
        ${row.vat_fils},
        ${row.vat_rate_bp},
        ${row.price_list_id},
        ${row.promotion_id},
        ${row.id}
      )
    `
  }

  // Forces the two DEFERRED triggers — `appointment_room_capacity` and
  // `appointment_delivery_is_coherent` — to fire HERE rather than at COMMIT, for the reason
  // `createBooking` gives: this transaction has finished rearranging, so a capacity or coherence refusal
  // arrives as a named error where the context is instead of from a COMMIT this function does not execute.
  await uow.sql`set constraints all immediate`

  await assertSuccessorsWereWritten(uow, {
    predecessorIds: moving.map((row) => row.id),
    tradingDate,
  })

  // The successors' reminder sets, built over the NEW period and therefore under new keys (B-MSG-03).
  // After `set constraints all immediate`, so the successors are already known to the two deferred
  // triggers by the time a step is attached to one — a step inserted against a row the capacity trigger
  // was about to reject would be a refusal naming the wrong table.
  await buildSuccessorSteps(uow, deps.steps, moving, successorIds)

  return {
    bookingId: first.booking_id,
    tradingDate,
    previousTradingDate,
    deliveryId,
    roomId: newRoomId,
    rows: moved,
    scheduledSteps,
  }
}

/**
 * The deps `transitionAppointment` is given: the decider, and B-MSG-03's step maintainer when there is one.
 *
 * A function rather than an inline object literal because `exactOptionalPropertyTypes` makes
 * `steps: deps.steps` a type error when it may be undefined, so the field has to be SPREAD conditionally —
 * and a conditional spread inside the per-row loop is a cognitive-complexity point `pnpm lint` counts
 * against a transaction already at its ceiling.
 */
function transitionDepsFrom(deps: RescheduleDeps): TransitionDeps {
  return { decide: deps.decide, ...(deps.steps === undefined ? {} : { steps: deps.steps }) }
}

/**
 * The successors' scheduled steps, built one row at a time (B-MSG-03).
 *
 * A function rather than a loop inside `rescheduleAppointment` for a reason `pnpm lint` states as a
 * number: that transaction is already at the cognitive-complexity ceiling, and one more loop pushes it
 * over. Sequentially rather than with `Promise.all`, because these are writes on one transaction — a
 * postgres.js transaction is one connection and concurrent statements on it interleave unpredictably.
 */
async function buildSuccessorSteps(
  uow: UnitOfWork,
  steps: ScheduledStepMaintainer | undefined,
  moving: readonly { readonly status: string }[],
  successorIds: readonly string[],
): Promise<void> {
  if (steps === undefined) return
  for (const [index, row] of moving.entries()) {
    await steps(uow, {
      appointmentId: successorIds[index] as string,
      toStatus: successorStatus(row.status),
    })
  }
}

/**
 * The status the successor is born in.
 *
 * `packages/db` may not import `packages/core`, and this is the one rule of B-LIFE-03's that is NOT
 * injected — deliberately, because it is a total function of a column this row already carries and
 * injecting it would mean a caller could hand back a status the lifecycle does not permit a booking to be
 * created in. `successorStatusFor` in `packages/core/src/lifecycle/reschedule-policy.ts` is the same
 * mapping, and `appointment-reschedule.itest.ts` asserts the two agree for every status the transition
 * table permits a reschedule from — which is what makes this a copy that cannot drift rather than a second
 * opinion.
 */
function successorStatus(predecessorStatus: string): 'requested' | 'confirmed' {
  // `requested` stays a request: a reschedule does not accept anything. `checked_in` cannot carry over —
  // the client has not arrived for a slot that has not happened — so it becomes `confirmed`. Anything
  // else is unreachable: `transitionAppointment` has already refused every other `from` status by the
  // transition table, which permits `-> rescheduled` only from these three.
  return predecessorStatus === 'requested' ? 'requested' : 'confirmed'
}

/**
 * The reschedule, in a transaction of its own, with the SQLSTATE translation the schema needs.
 *
 * `bookingError` is B-AVAIL-06's translator, reused rather than re-written: the constraints a reschedule
 * can violate are exactly the ones a booking can — the therapist exclusion (23P01), the room capacity
 * trigger (ZB001), the delivery coherence trigger (ZB004) and the `business_day` foreign key — and a second
 * translation table would answer the same question differently the first time one of them changed.
 */
export async function rescheduleAppointmentTx(
  sql: Sql,
  input: RescheduleInput,
  deps: RescheduleDeps,
  context: RequestContext = {},
): Promise<RescheduleResult> {
  const actor: Actor = {
    kind: input.actor.kind,
    ...(input.actor.id === undefined ? {} : { id: input.actor.id }),
    ...(input.actor.label === undefined ? {} : { label: input.actor.label }),
  }
  try {
    return await withUnitOfWork(
      sql,
      actor,
      (uow) => rescheduleAppointment(uow, input, deps),
      context,
    )
  } catch (err) {
    throw bookingError(err) ?? err
  }
}

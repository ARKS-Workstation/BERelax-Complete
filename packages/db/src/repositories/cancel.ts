import { AppError } from '@berelax/shared'
import type { Actor, RequestContext } from '../audit.ts'
import type { Sql } from '../connection.ts'
import { readCancellationWindow } from '../settings/cancellation.ts'
import type { UnitOfWork } from '../tx.ts'
import { withUnitOfWork } from '../tx.ts'
import {
  type TransitionActor,
  type TransitionDecider,
  type TransitionDeps,
  type TransitionResult,
  transitionAppointment,
} from './appointment-transition.ts'
import { revokeBookingManageGrants } from './booking-token.ts'
import type { ScheduledStepMaintainer } from './scheduled-step.ts'

/**
 * Cancellation and the no-show, as writes (B-LIFE-03).
 *
 * Both are `transitionAppointment` — B-LIFE-01's write path, which decides the move, appends the history
 * row, writes the audit row and enqueues exactly one outbox event — with one thing added that the transition
 * table cannot hold, because holding it would mean holding a clock:
 *
 *   - a **cancellation** is classified against `booking.cancellation_window_hours` and, when it is inside
 *     the window, sets `late_cancellation` and the window figure it was judged against (0049);
 *   - a **no-show** is refused until the appointment's start is in the past.
 *
 * ## The flag is not a charge, and nothing here writes money
 *
 * The window is an F09 setting declared `provisional: true` against **Y9-windows**: no fee policy is agreed
 * and the business takes no card payments. So a late cancellation writes exactly two things — the flag and
 * the hours it was judged against — and **zero** payment, invoice, fee or ledger rows. There is no code path
 * here that could write one: `cancellationCharge` in `@berelax/core` answers zero for every input, and the
 * amount it answers is carried into the audit row and the event so a reader can see that it was zero rather
 * than assume it.
 *
 * ## Why the clock is an argument
 *
 * `packages/core` may not read a clock, and neither does this file. `nowMs` is supplied by the caller, which
 * is what makes "refused one minute before the start, accepted one minute after" a frozen-clock test rather
 * than a test that passes until midnight. `now()` in SQL would have been the shortest version and it is the
 * one thing that cannot be tested.
 *
 * ## A booking is cancelled all at once or not at all
 *
 * `cancelBooking` moves every LIVE appointment of the booking in ONE transaction. A couples booking is two
 * rows, and a half-cancelled couples booking is the state docs/03 warns about — one customer told their
 * treatment is cancelled and the other not. Because the two moves are two calls to `transitionAppointment`
 * inside one unit of work, a refusal on the second rolls the first back with it: there is no code here that
 * has to remember to undo anything, which is the only version of all-or-none that survives a partial
 * failure.
 *
 * Which rows count as "every appointment" is a decision with a defect behind it, and the predicate in
 * {@link cancelBooking} says which and why.
 */

/** Every reason this file refuses, beyond the transition refusals it passes through. */
export const CANCELLATION_REFUSALS = [
  /** No appointment with that id. */
  'appointment_not_found',
  /** No booking with that id, or it holds no appointments at all. */
  'booking_not_found',
  /**
   * The booking exists and every appointment in it is already cancelled, a no-show or superseded.
   *
   * A separate refusal from `booking_not_found`, because they send the reader to different places: one
   * means the id is wrong and the other means the work is already done.
   */
  'booking_has_nothing_to_cancel',
  /** The appointment has not started, so nobody can have failed to arrive for it. */
  'appointment_not_started',
  /** No cancellation policy was injected, so nothing judged the window. Fail closed. */
  'cancellation_not_classified',
  /** No clock guard was injected, so nothing checked the start was past. Fail closed. */
  'no_show_clock_not_checked',
  /** The flag was not stored as the policy decided it. Read back, never assumed. */
  'late_cancellation_not_recorded',
] as const
export type CancellationRefusal = (typeof CANCELLATION_REFUSALS)[number]

/** The two cancellation states. Distinct, and never collapsed into one `cancelled` (B-LIFE-01). */
export const CANCELLATION_STATUSES = ['cancelled_by_customer', 'cancelled_by_salon'] as const
export type CancellationStatus = (typeof CANCELLATION_STATUSES)[number]

/** What the injected policy answers. Field for field `CancellationVerdict` in core. */
export interface CancellationClassification {
  readonly late: boolean
  readonly windowHours: number
  readonly noticeMinutes: number
  /** Zero. Carried so the audit row records the figure rather than the absence of one. */
  readonly chargeFils: number
}

/**
 * `cancellationVerdictFor` from `@berelax/core`, injected.
 *
 * A function rather than an import because `packages/db` must never import `packages/core`. `windowHours` is
 * `unknown` because it is the value as STORED: normalising it is core's, and a corrupt row must not be
 * coerced to zero on the way across — zero is a legal window meaning "flag nothing".
 */
export type CancellationPolicy = (input: {
  readonly startsAtMs: number
  readonly atMs: number
  readonly windowHours: unknown
}) => CancellationClassification

/** What the injected clock guard answers. Field for field `NoShowClockVerdict` in core. */
export type NoShowClockCheck = (input: { readonly startsAtMs: number; readonly atMs: number }) =>
  | { readonly kind: 'allowed'; readonly minutesSinceStart: number }
  | {
      readonly kind: 'refused'
      readonly refusal: string
      readonly why: string
      readonly minutesUntilStart: number
    }

export interface CancelDeps {
  readonly decide: TransitionDecider
  readonly classify: CancellationPolicy
  /**
   * B-MSG-03's scheduled-step maintainer, passed through to {@link transitionAppointment}.
   *
   * A cancellation settles the appointment's pending reminders as `cancelled`. Optional in the type so
   * every caller written before B-MSG-03 compiles, and NOT a permissive default: 0051's deferred
   * constraint trigger refuses any transaction that commits a pending step on an appointment which no
   * longer holds its resources, so a cancellation without this fails by name instead of leaving a live
   * reminder on a cancelled booking.
   */
  readonly steps?: ScheduledStepMaintainer
}

export interface NoShowDeps {
  readonly decide: TransitionDecider
  readonly clock: NoShowClockCheck
  /** The same seam, for the same reason. A no-show has nothing left to remind anybody about. */
  readonly steps?: ScheduledStepMaintainer
}

/** The deps `transitionAppointment` is given, with the optional step maintainer spread rather than set. */
const transitionDepsFrom = (deps: {
  readonly decide: TransitionDecider
  readonly steps?: ScheduledStepMaintainer
}): TransitionDeps => ({
  decide: deps.decide,
  ...(deps.steps === undefined ? {} : { steps: deps.steps }),
})

export interface CancelAppointmentInput {
  readonly appointmentId: string
  readonly to: CancellationStatus
  readonly actor: TransitionActor
  /**
   * Why. Mandatory for `cancelled_by_salon` and optional for the customer's own cancellation, exactly as
   * the transition table declares — refusing a customer's cancellation for want of a reason turns it into a
   * no-show, which is a worse record of the same evening.
   */
  readonly reason?: string
  /** The instant the cancellation was made. An ARGUMENT, never `now()`. */
  readonly nowMs: number
}

export interface CancelBookingInput {
  readonly bookingId: string
  readonly to: CancellationStatus
  readonly actor: TransitionActor
  readonly reason?: string
  readonly nowMs: number
}

export interface MarkNoShowInput {
  readonly appointmentId: string
  readonly actor: TransitionActor
  readonly reason?: string
  /** The instant the judgement is being made. An ARGUMENT, never `now()`. */
  readonly nowMs: number
}

export interface CancelledAppointment {
  readonly appointmentId: string
  readonly transition: TransitionResult
  /** True when the cancellation arrived inside the window and the flag was set. */
  readonly lateCancellation: boolean
  readonly windowHours: number
  readonly noticeMinutes: number
  /** Always zero. See the header. */
  readonly chargeFils: number
}

export interface CancelBookingResult {
  readonly bookingId: string
  readonly appointments: readonly CancelledAppointment[]
}

export interface NoShowResult {
  readonly appointmentId: string
  readonly transition: TransitionResult
  readonly minutesSinceStart: number
}

const refusal = (
  kind: 'conflict' | 'validation' | 'invariant_violated' | 'not_found',
  name: CancellationRefusal,
  message: string,
  extra: Record<string, unknown> = {},
): AppError =>
  new AppError(kind, `${name}: ${message}`, {
    userFacing: true,
    details: { refusal: name, ...extra },
  })

/** The refusal an error carries, or `null`. Lets a caller branch without matching on the message. */
export function cancellationRefusalOf(err: unknown): CancellationRefusal | null {
  const name = err instanceof AppError ? err.details['refusal'] : undefined
  return CANCELLATION_REFUSALS.includes(name as CancellationRefusal)
    ? (name as CancellationRefusal)
    : null
}

interface StartRow {
  readonly starts_at: Date
  readonly status: string
  readonly late_cancellation: boolean
}

/**
 * The appointment's start, read under the row lock this transaction is about to write through.
 *
 * `FOR UPDATE` here and again in `transitionAppointment` is one lock taken twice, not two locks: the second
 * is free. Taking it here matters because the start instant is what the window and the clock guard are
 * judged against, and a start read without the lock could be a start another transaction has already moved
 * by rescheduling the appointment.
 */
async function lockedStart(uow: UnitOfWork, appointmentId: string): Promise<StartRow> {
  const [row] = await uow.sql<StartRow[]>`
    select lower(period) as starts_at, status::text as status, late_cancellation
      from appointment where id = ${appointmentId}
       for update
  `
  if (row === undefined) {
    throw refusal('not_found', 'appointment_not_found', `no appointment with id ${appointmentId}`, {
      appointmentId,
    })
  }
  return row
}

/**
 * Cancels one appointment inside an existing unit of work.
 *
 * Exported for {@link cancelBooking}, which composes it, and for a caller that cancels one row of a couples
 * booking deliberately — the front desk does that when one of two clients drops out.
 */
export async function cancelAppointment(
  uow: UnitOfWork,
  input: CancelAppointmentInput,
  deps: CancelDeps,
): Promise<CancelledAppointment> {
  // Fail closed. A cancellation recorded without the window being judged is a cancellation whose
  // late-ness nobody decided, and the permissive default — "not late" — is the one that quietly stops the
  // flag ever being set.
  if (typeof deps?.classify !== 'function') {
    throw refusal(
      'invariant_violated',
      'cancellation_not_classified',
      'no cancellation policy was supplied, so nothing judged the window. `cancellationVerdictFor` from ' +
        '@berelax/core is the rule; packages/db may not import it, so the caller injects it.',
    )
  }
  const appointment = await lockedStart(uow, input.appointmentId)
  const verdict = deps.classify({
    startsAtMs: appointment.starts_at.getTime(),
    atMs: input.nowMs,
    // As STORED. Core normalises it, so a corrupt row cannot reach the flag as a zero window.
    windowHours: await readCancellationWindow(uow.sql),
  })

  const transition = await transitionAppointment(
    uow,
    {
      appointmentId: input.appointmentId,
      to: input.to,
      actor: input.actor,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      // The facts only this transaction knows, into the audit row and the event. `charge_fils: 0` is
      // written out rather than omitted: an absent amount reads as "not considered", and the whole point
      // of Y9-windows being provisional is that somebody will later ask what was charged.
      extra: {
        late_cancellation: verdict.late,
        cancellation_window_hours: verdict.windowHours,
        notice_minutes: verdict.noticeMinutes,
        charge_fils: verdict.chargeFils,
        cancellation_open_question: 'Y9-windows',
      },
    },
    transitionDepsFrom(deps),
  )

  // Only after the status is cancelled, because `appointment_late_cancellation_needs_a_cancellation`
  // (0049) refuses the flag on anything else — and only when the verdict says so, because the flag and the
  // window figure are whole-or-nothing in the same migration.
  if (transition.kind === 'transitioned' && verdict.late) {
    await uow.sql`
      update appointment
         set late_cancellation = true,
             late_cancellation_window_hours = ${verdict.windowHours}
       where id = ${input.appointmentId}
    `
    // Read back, not assumed — the same reason `transitionAppointment` reads its history row back. A
    // constraint that silently refused this, or an UPDATE that matched no row, would leave a cancellation
    // that reads as on time; and the flag is what a fee policy will one day be applied to.
    const [stored] = await uow.sql<{ late: boolean; hours: number | null }[]>`
      select late_cancellation as late, late_cancellation_window_hours as hours
        from appointment where id = ${input.appointmentId}
    `
    if (stored?.late !== true || Number(stored.hours) !== verdict.windowHours) {
      throw refusal(
        'invariant_violated',
        'late_cancellation_not_recorded',
        'the late-cancellation flag and the window it was judged against were not stored. A flag with ' +
          'no figure cannot be accounted for, which is why 0049 makes the pair whole-or-nothing.',
        { stored, expected: { late: true, hours: verdict.windowHours } },
      )
    }
  }

  /*
    B-UI-05. Every live magic link on the booking is revoked, in this transaction.

    A DELETE and not a flag, for 0064's reason: the row goes and the `audit_event` for the minting stays.
    EVERY grant on the booking rather than the one somebody presented, because a reminder mints a link per
    send — a booking with a 24-hour and a 2-hour reminder has two live links, and revoking one leaves the
    customer who cancelled by telephone still able to reschedule from the older SMS.

    Called directly rather than injected as a dep, unlike `classify` and `steps` above. Those two are
    injected because they are `packages/core`'s rules and this package may not import them; this is a write
    in this package, so an optional dependency would buy nothing and would mean a link that stays live
    whenever a caller forgets. It is inside the transaction, so the revocation commits with the status
    change or not at all: a cancellation that rolled back must not leave the booking unmanageable, and a
    committed one must not leave it manageable.

    It is on `cancelAppointment` rather than on `cancelBooking`, which composes it, because the front desk
    cancels one row of a couples booking deliberately — and the link is per BOOKING, so the second row's
    cancellation finds nothing left to revoke and answers zero. That is the right shape: a booking with any
    appointment cancelled has had its self-service link withdrawn, and a customer who wants to move the
    other half telephones the desk. Widening the link to survive a partial cancellation would mean a page
    offering to reschedule an appointment that may not exist.
  */
  if (transition.kind === 'transitioned') {
    const [row] = await uow.sql<{ booking_id: string }[]>`
      select booking_id::text as booking_id from appointment where id = ${input.appointmentId}
    `
    if (row !== undefined) {
      await revokeBookingManageGrants(uow, {
        bookingId: row.booking_id,
        reason: `appointment ${input.appointmentId} moved to ${input.to}`,
      })
    }
  }

  return {
    appointmentId: input.appointmentId,
    transition,
    lateCancellation: verdict.late && transition.kind === 'transitioned',
    windowHours: verdict.windowHours,
    noticeMinutes: verdict.noticeMinutes,
    chargeFils: verdict.chargeFils,
  }
}

/**
 * Cancels every appointment of a booking. All of them, or none.
 *
 * The rows are read in id order and moved one at a time inside ONE unit of work, so a refusal on the second
 * takes the first back with it. Nothing here compensates or retries: the transaction is the mechanism, which
 * is the only version of this that is still true when the failure is a constraint nobody predicted.
 *
 * A row the lifecycle cannot move — one already `completed`, or `in_progress` — refuses the WHOLE
 * cancellation with the transition table's own `illegal_transition`. That is deliberate and it is the
 * conservative reading: a booking with one treatment already delivered is not a booking the front desk may
 * cancel with one tap, because the delivered half has been paid for.
 */
export async function cancelBooking(
  uow: UnitOfWork,
  input: CancelBookingInput,
  deps: CancelDeps,
): Promise<CancelBookingResult> {
  // Which rows are "every appointment in the booking" is a decision, and getting it wrong makes a
  // booking permanently uncancellable.
  //
  // A reschedule leaves the SUPERSEDED row in the same booking (its `booking_id` is copied to the
  // successor, because the booking is the commercial record and the move does not create a second sale).
  // `rescheduled` is terminal, so a cancellation that took every row of the booking would be refused with
  // `illegal_transition` by the superseded one for ever after — the customer's live appointment could not
  // be cancelled at all because an earlier version of it exists. So the rows taken are the ones that still
  // HOLD their resources (0024's generated column, which is false for `rescheduled`, both cancellations
  // and `no_show`), plus any already in the status being asked for: that second half is what keeps a
  // double-tapped Cancel idempotent instead of turning it into "nothing to cancel".
  //
  // `in_progress` and `completed` DO hold their resources, so they are included and the transition table
  // refuses the whole booking. That is the conservative reading on purpose: a booking with one treatment
  // already delivered is not one the front desk may cancel with a single tap.
  const rows = await uow.sql<{ id: string }[]>`
    select id::text as id from appointment
     where booking_id = ${input.bookingId}
       and (holds_resources or status = ${input.to}::appointment_status)
     order by appointment.id
  `
  if (rows.length === 0) {
    const [held] = await uow.sql<{ n: string }[]>`
      select count(*)::text as n from appointment where booking_id = ${input.bookingId}
    `
    if (Number(held?.n ?? 0) === 0) {
      throw refusal(
        'not_found',
        'booking_not_found',
        `booking ${input.bookingId} holds no appointments, so there is nothing to cancel`,
        { bookingId: input.bookingId },
      )
    }
    throw refusal(
      'conflict',
      'booking_has_nothing_to_cancel',
      `every appointment in booking ${input.bookingId} is already cancelled, a no-show or superseded by ` +
        'a reschedule, so none of them holds a period to release',
      { bookingId: input.bookingId, appointments: Number(held?.n ?? 0) },
    )
  }
  const cancelled: CancelledAppointment[] = []
  for (const row of rows) {
    cancelled.push(
      await cancelAppointment(
        uow,
        {
          appointmentId: row.id,
          to: input.to,
          actor: input.actor,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          nowMs: input.nowMs,
        },
        deps,
      ),
    )
  }
  return { bookingId: input.bookingId, appointments: cancelled }
}

/**
 * Marks an appointment a no-show, which is refused until its start is in the past.
 *
 * The guard runs BEFORE the transition, so a future appointment is refused without a history row, an audit
 * row or an event — the front desk learns it has the wrong appointment in front of it, and nothing records a
 * judgement against the customer. The transition table still decides whether the move is legal at all
 * (`confirmed` and `checked_in` only) and whether this role may make it (owner or manager): this narrows
 * what may be asked for and never widens it.
 */
export async function markNoShow(
  uow: UnitOfWork,
  input: MarkNoShowInput,
  deps: NoShowDeps,
): Promise<NoShowResult> {
  // Fail closed. Without the guard a no-show is markable against tomorrow's appointment, and the
  // permissive default is invisible: the row reads exactly like a real one.
  if (typeof deps?.clock !== 'function') {
    throw refusal(
      'invariant_violated',
      'no_show_clock_not_checked',
      'no clock guard was supplied, so nothing checked that the appointment has started. ' +
        '`noShowVerdictFor` from @berelax/core is the rule; packages/db may not import it — and may not ' +
        'read a clock either — so the caller injects it and supplies the instant.',
    )
  }
  const appointment = await lockedStart(uow, input.appointmentId)
  const guard = deps.clock({
    startsAtMs: appointment.starts_at.getTime(),
    atMs: input.nowMs,
  })
  if (guard.kind === 'refused') {
    throw refusal('conflict', 'appointment_not_started', guard.why, {
      appointmentId: input.appointmentId,
      minutesUntilStart: guard.minutesUntilStart,
      guard: guard.refusal,
    })
  }

  const transition = await transitionAppointment(
    uow,
    {
      appointmentId: input.appointmentId,
      to: 'no_show',
      actor: input.actor,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      extra: {
        minutes_since_start: guard.minutesSinceStart,
        // A no-show charges nothing either, for the same reason a late cancellation does not.
        charge_fils: 0,
        cancellation_open_question: 'Y9-windows',
      },
    },
    transitionDepsFrom(deps),
  )
  return {
    appointmentId: input.appointmentId,
    transition,
    minutesSinceStart: guard.minutesSinceStart,
  }
}

/** {@link cancelAppointment} in a transaction of its own. */
export async function cancelAppointmentTx(
  sql: Sql,
  input: CancelAppointmentInput,
  deps: CancelDeps,
  context: RequestContext = {},
): Promise<CancelledAppointment> {
  return await withUnitOfWork(
    sql,
    actorOf(input.actor),
    (uow) => cancelAppointment(uow, input, deps),
    context,
  )
}

/** {@link cancelBooking} in a transaction of its own. The all-or-none boundary IS this transaction. */
export async function cancelBookingTx(
  sql: Sql,
  input: CancelBookingInput,
  deps: CancelDeps,
  context: RequestContext = {},
): Promise<CancelBookingResult> {
  return await withUnitOfWork(
    sql,
    actorOf(input.actor),
    (uow) => cancelBooking(uow, input, deps),
    context,
  )
}

/** {@link markNoShow} in a transaction of its own. */
export async function markNoShowTx(
  sql: Sql,
  input: MarkNoShowInput,
  deps: NoShowDeps,
  context: RequestContext = {},
): Promise<NoShowResult> {
  return await withUnitOfWork(
    sql,
    actorOf(input.actor),
    (uow) => markNoShow(uow, input, deps),
    context,
  )
}

/**
 * The audit actor, from the transition actor.
 *
 * One argument produces both, because two would let a caller audit one actor and authorise another — the
 * same reason `transitionAppointmentTx` derives it rather than taking it.
 */
function actorOf(actor: TransitionActor): Actor {
  return {
    kind: actor.kind,
    ...(actor.id === undefined ? {} : { id: actor.id }),
    ...(actor.label === undefined ? {} : { label: actor.label }),
  }
}

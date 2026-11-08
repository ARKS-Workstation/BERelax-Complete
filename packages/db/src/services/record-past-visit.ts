import {
  type TransitionActor,
  type TransitionDeps,
  type TransitionResult,
  transitionAppointment,
} from '../repositories/appointment-transition.ts'
import {
  type CreateBookingDeps,
  type CreateBookingInput,
  type CreatedBooking,
  createBooking,
} from '../repositories/create-booking.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * Records a visit that happened and was never entered, in one transaction.
 *
 * ## What this composes, and what it refuses to shortcut
 *
 * Two things already exist and both are used whole. `createBooking` writes the appointment — it already
 * takes an explicit trading date and an explicit `{ startsAt, endsAt }`, because the availability gate
 * lives ABOVE it in the booking API, not inside it. And `transitionAppointment` moves the row through
 * the lifecycle, writing a history row, an audit row and an outbox event for each step.
 *
 * The obvious shortcut is to insert the appointment at `completed` and be done. This does not, and that
 * is the whole design. `BOOKABLE_STATUSES` is `requested` and `confirmed` — "a lifecycle transition is
 * B-LIFE-01's, not this unit's" — and an appointment that arrived at `completed` with no history behind
 * it is a row no audit can account for, in the one table whose history IS the audit trail. So a recorded
 * visit walks `confirmed → checked_in → in_progress → completed`, or `confirmed → no_show`, and comes out
 * indistinguishable from a live one except in the one way it should differ: every step says it was
 * entered after the fact, and when.
 *
 * It also means the revenue event fires from the same place it always does. `completed` is the one state
 * that `emitsRevenue`, because "COMPLETED is what emits revenue events, not CONFIRMED — booking value is
 * a guess, the till knows the truth". A backdated visit that skipped it would be a treatment the ledger
 * never hears about, which is the half of this that the owner actually asked for.
 *
 * ## Why the slot re-check is kept
 *
 * `createBooking` refuses without one (`slot_not_revalidated`), and that refusal is right here rather
 * than something to work around. For a past visit the question it asks is not "is the therapist free
 * now" but "was anything else already recorded against this therapist and room on that trading date",
 * which is exactly what it reads. The `btree_gist` exclusion on `(therapist_id, period)` is the backstop
 * underneath it: two overlapping treatments for one therapist cannot have happened.
 *
 * ## Why the policy verdict is not computed here
 *
 * `backdatedVisitVerdict` in `@berelax/core` decides whether the instant may be recorded at all — in the
 * past, finished, within the horizon, inside a trading session. `packages/db` may not import
 * `@berelax/core` (ADR 0001), so the caller applies it and passes the result of having done so. That is
 * the same seam `createBooking` uses for `assignShape`, and for the same reason.
 */

export type PastVisitOutcome = 'completed' | 'no_show'

/** The lifecycle each outcome walks. `confirmed` is where `createBooking` leaves the row. */
const WALK: Readonly<Record<PastVisitOutcome, readonly string[]>> = Object.freeze({
  completed: Object.freeze(['checked_in', 'in_progress', 'completed']),
  no_show: Object.freeze(['no_show']),
})

export interface RecordPastVisitInput {
  /**
   * The booking, already carrying the PAST trading date and period.
   *
   * `status` is forced to `confirmed` below rather than taken from the caller: a visit that happened was
   * never `requested`, and the walk starts from a known state.
   */
  readonly booking: CreateBookingInput
  readonly outcome: PastVisitOutcome
  readonly actor: TransitionActor
  /** The instant the entry is being made — the clock, not the visit. Recorded on every step. */
  readonly enteredAtIso: string
  /** Why it was missed, when the desk gave a reason. Never stored as `''`. */
  readonly reason?: string
}

/**
 * What was written. There is no refusal variant: `transitionAppointment` THROWS on a refused move, and
 * that is the behaviour this wants — a half-walked appointment has no correct partial state, so the
 * caller's transaction must roll the whole thing back rather than be handed a value to branch on.
 */
export interface RecordPastVisitResult {
  readonly booking: CreatedBooking
  readonly steps: readonly TransitionResult[]
}

export async function recordPastVisit(
  uow: UnitOfWork,
  input: RecordPastVisitInput,
  deps: CreateBookingDeps & TransitionDeps,
): Promise<RecordPastVisitResult> {
  const booking = await createBooking(
    uow,
    {
      ...input.booking,
      deliveries: input.booking.deliveries.map((delivery) => ({
        ...delivery,
        status: 'confirmed',
      })),
    },
    deps,
  )

  const steps: TransitionResult[] = []
  for (const [index, delivery] of booking.deliveries.entries()) {
    /*
     * Every appointment of the delivery, because a couples booking is two appointment rows under one
     * delivery and both were delivered. Walking only the first would complete one client's treatment and
     * leave the other's confirmed for ever.
     */
    const startedAtIso = new Date(
      input.booking.deliveries[index]?.treatment.startsAt ?? Number.NaN,
    ).toISOString()
    for (const appointmentId of delivery.appointmentIds) {
      for (const to of WALK[input.outcome]) {
        const result = await transitionAppointment(
          uow,
          {
            appointmentId,
            to,
            actor: input.actor,
            ...(input.reason === undefined || input.reason === '' ? {} : { reason: input.reason }),
            /*
             * The marker that makes this honest. It lands in `audit_event.after` and in the outbox
             * payload of EVERY step, not only the last: a reader looking at why a treatment was checked
             * in at 19:00 on a day that has already closed gets the answer on the row they are looking at,
             * rather than having to find the completion to learn that none of it happened live.
             *
             * `snake_case`, because the same object is written into `audit_event.after`, which has spelled
             * its facts that way since migration 0005.
             */
            extra: {
              recorded_after_the_fact: true,
              entered_at: input.enteredAtIso,
              visit_started_at: startedAtIso,
            },
          },
          deps,
        )
        // `no_op` is kept rather than skipped: a repeated `no_show` is declared idempotent by the
        // transition table, and recording that the step was asked for is the honest trace.
        steps.push(result)
      }
    }
  }

  return { booking, steps }
}

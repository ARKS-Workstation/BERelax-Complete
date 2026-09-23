import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * The scheduled step's writes and reads (B-MSG-03).
 *
 * A reminder is a ROW here and a delayed job nowhere. The queue carries a step id, the worker re-reads the
 * appointment under this row's lock, and `packages/core`'s `decideScheduledStep` decides — so a message
 * that should no longer be sent is refused at the moment of sending rather than at the moment it was
 * scheduled, which is the only moment that can know.
 *
 * ## Why the rules arrive as functions
 *
 * `packages/db` may never import `packages/core` (ADR 0001, `pnpm boundaries`), and the rule this module
 * needs is core's: which steps an appointment should have, and under which keys
 * ({@link ScheduledStepPlanner}). It is injected, the same way `createBooking` takes its slot re-check,
 * `transitionAppointment` its decider and B-LIFE-03's reschedule its trading-date resolver, and a caller
 * that omits it is refused by name rather than defaulted — a permissive default here IS the bug this unit
 * exists to remove. The other rule, what to do with a step that has come due, is core's
 * `decideScheduledStep`, and it is applied by the worker: `apps/worker` may import both packages, so the
 * seam is a composition rather than an injection there.
 *
 * ## Why the maintainer is one function and not four
 *
 * CONFIRMED builds the set, RESCHEDULED supersedes it, and both cancellations plus NO_SHOW settle it.
 * Four call sites would be four places to forget, and the one that was forgotten would be the one with
 * the customer standing in the wrong salon. So there is one {@link ScheduledStepMaintainer}, it is handed
 * the status the appointment has just moved INTO, and it is injected into `transitionAppointment` — which
 * is B-LIFE-01's single write path for every transition in the lifecycle. The reschedule calls it a
 * second time, for the successor, because a successor is born by INSERT and never transitions into its
 * status.
 *
 * ## And why the database refuses the omission anyway
 *
 * The dep is optional in the type, so that every existing caller of `transitionAppointment` compiles
 * unchanged — and that would be exactly the permissive default this file just said it would not have, if
 * it were the only layer. It is not. 0051's deferred constraint trigger refuses any transaction that
 * COMMITS a pending step on an appointment which no longer holds its resources, so a caller that omits
 * the maintainer does not silently leave a live reminder on a cancelled booking: it fails, by name, with
 * the step and the appointment in the message. The omission is loud rather than dangerous, which is the
 * same two-layer shape 0035 gives for the status-regression rule.
 */

/**
 * Every reason a scheduled-step write is refused. Callers branch on these, never on prose.
 *
 * Two, and deliberately only two. A name here is a refusal something really throws: the first draft also
 * carried `step_not_decided`, `step_not_found` and `step_has_no_recipient`, and none of the three was
 * reachable — the decision is the WORKER's (it may import core, so it composes rather than injects), a
 * missing step is a returned `not_found` outcome rather than an error, and a booking with no phone number
 * is a fact to RECORD on the row rather than a transaction to abort. A vocabulary carrying names nothing
 * raises sends the next reader looking for a code path that does not exist.
 */
export const SCHEDULED_STEP_REFUSALS = [
  /** No planner was injected, so nothing derived the keys. Fail closed. */
  'step_plan_not_derived',
  /** The row left `pending` between the lock and the write, so the send has no step to belong to. */
  'step_not_settled',
] as const
export type ScheduledStepRefusal = (typeof SCHEDULED_STEP_REFUSALS)[number]

const refusal = (
  kind: 'conflict' | 'validation' | 'invariant_violated' | 'not_found',
  name: ScheduledStepRefusal,
  message: string,
  extra: Record<string, unknown> = {},
): AppError =>
  new AppError(kind, `${name}: ${message}`, {
    userFacing: true,
    details: { refusal: name, ...extra },
  })

/** The refusal an error carries, or `null`. Lets a caller branch without matching on the message. */
export function scheduledStepRefusalOf(err: unknown): ScheduledStepRefusal | null {
  const name = err instanceof AppError ? err.details['refusal'] : undefined
  return SCHEDULED_STEP_REFUSALS.includes(name as ScheduledStepRefusal)
    ? (name as ScheduledStepRefusal)
    : null
}

/** One step the plan says should exist. Mirrors `PlannedScheduledStep` in `@berelax/core`. */
export interface PlannedStep {
  readonly stepType: string
  readonly sendAtMs: number
  readonly invalidationKey: string
}

/**
 * `reminderPlanFor` from `@berelax/core`, injected, already bound to the reminder offsets in force.
 *
 * The offsets are read from `app_setting` by {@link readReminderOffsets} and validated by core, so this
 * seam carries only what a transaction cannot know: the appointment and the period it holds right now.
 */
export type ScheduledStepPlanner = (input: {
  readonly appointmentId: string
  readonly period: { readonly startsAtMs: number; readonly endsAtMs: number }
}) => readonly PlannedStep[]

/** What one lifecycle fact did to the steps of one appointment. */
export interface ScheduledStepMaintenance {
  readonly appointmentId: string
  /** `build`, `supersede`, `cancel` or `none` — what the status asked for. */
  readonly action: 'build' | 'supersede' | 'cancel' | 'none'
  /** The step types inserted, in plan order. */
  readonly built: readonly string[]
  /** Pending rows moved out of `pending`. */
  readonly settled: number
}

/**
 * The seam `transitionAppointment` and the reschedule call.
 *
 * A function rather than an object so the injection reads the same as every other rule in this package,
 * and so a test can substitute one that counts calls without building a store.
 */
export type ScheduledStepMaintainer = (
  uow: UnitOfWork,
  input: { readonly appointmentId: string; readonly toStatus: string },
) => Promise<ScheduledStepMaintenance>

/**
 * The statuses that settle a pending step, and what each one settles it AS.
 *
 * `rescheduled` is `superseded` and a cancellation is `cancelled` because the two answer different
 * questions later: how many reminders did moving bookings cost us, against how many did cancelled ones.
 * `no_show` cancels for the same reason a cancellation does — there is nothing left to remind anybody
 * about — and it is listed rather than folded into a default, because a status reaching here that nobody
 * considered must do NOTHING rather than guess.
 */
const SETTLES_AS: Readonly<Record<string, 'superseded' | 'cancelled'>> = Object.freeze({
  rescheduled: 'superseded',
  cancelled_by_customer: 'cancelled',
  cancelled_by_salon: 'cancelled',
  no_show: 'cancelled',
})

/** The appointment facts a plan is built from. Read under the caller's lock, never remembered. */
interface AppointmentPeriodRow {
  readonly id: string
  readonly starts_at: Date
  readonly ends_at: Date
  readonly holds_resources: boolean
}

async function readPeriod(
  sql: Sql,
  appointmentId: string,
): Promise<AppointmentPeriodRow | undefined> {
  const [row] = await sql<AppointmentPeriodRow[]>`
    select id::text as id, lower(period) as starts_at, upper(period) as ends_at, holds_resources
      from appointment where id = ${appointmentId}
  `
  return row
}

/**
 * Builds the plan's missing steps for one appointment.
 *
 * `on conflict do nothing` against `scheduled_step_one_pending_step_per_type`, so a repeated build — a
 * double-tapped Confirm, a rebuild pass that overlaps a confirmation — inserts nothing rather than
 * raising. That index is partial on `state = 'pending'`, which is what makes the conflict target the
 * right one: a *superseded* row with the same pair is history and must not block the new step.
 *
 * Nothing is built for an appointment that no longer holds its resources. It would be refused by 0051's
 * deferred trigger at COMMIT anyway; refusing it here means the caller gets `built: []` and a transaction
 * that still commits, which is the right answer for a rebuild pass sweeping a whole forward book.
 */
export async function buildScheduledSteps(
  uow: UnitOfWork,
  input: { readonly appointmentId: string },
  deps: { readonly plan?: ScheduledStepPlanner },
): Promise<readonly string[]> {
  if (typeof deps?.plan !== 'function') {
    throw refusal(
      'invariant_violated',
      'step_plan_not_derived',
      'no step planner was supplied, so nothing derived the invalidation keys. `reminderPlanFor` from ' +
        '@berelax/core is the rule; packages/db may not import it, so the caller injects it. A default ' +
        'here would schedule reminders under keys nobody derived, which is the failure this unit exists ' +
        'to remove.',
    )
  }
  const appointment = await readPeriod(uow.sql, input.appointmentId)
  if (appointment === undefined || !appointment.holds_resources) return []

  const built: string[] = []
  for (const planned of deps.plan({
    appointmentId: input.appointmentId,
    period: {
      startsAtMs: appointment.starts_at.getTime(),
      endsAtMs: appointment.ends_at.getTime(),
    },
  })) {
    // A step due at or after the treatment start is refused by 0051's trigger, and it is not a defect:
    // a booking taken an hour before the treatment really has missed its 24-hour reminder. Skipping the
    // INSERT rather than letting the trigger refuse the whole transaction is what keeps a late booking
    // bookable — and the miss is still visible, because the steps the appointment DOES have are the
    // plan minus this one.
    if (planned.sendAtMs >= appointment.starts_at.getTime()) continue
    const rows = await uow.sql<{ step_type: string }[]>`
      insert into scheduled_step (appointment_id, step_type, invalidation_key, send_at)
      values (${input.appointmentId}, ${planned.stepType}, ${planned.invalidationKey},
              ${new Date(planned.sendAtMs).toISOString()}::timestamptz)
      on conflict (appointment_id, step_type) where state = 'pending' do nothing
      returning step_type
    `
    if (rows.length > 0) built.push(planned.stepType)
  }
  return built
}

/** Moves every pending step of one appointment to a terminal state. Returns how many moved. */
export async function settleScheduledSteps(
  uow: UnitOfWork,
  input: { readonly appointmentId: string; readonly state: 'superseded' | 'cancelled' },
): Promise<number> {
  const rows = await uow.sql<{ id: string }[]>`
    update scheduled_step
       set state = ${input.state}::scheduled_step_state,
           -- now() is the TRANSACTION's instant, which is the right one here: this is the moment the
           -- lifecycle wrote, not a judgement anybody passed about a business time. The worker's own two
           -- settlers take an instant instead, because a drain is judged against a clock it was handed.
           settled_at = now()
     where appointment_id = ${input.appointmentId} and state = 'pending'
    returning id
  `
  return rows.length
}

/**
 * The maintainer, bound to a planner.
 *
 * Built by a factory rather than exported as a bare function because the planner is the injected rule and
 * every call site would otherwise have to carry it. `transitionAppointment` takes the result.
 */
export function scheduledStepMaintainer(deps: {
  readonly plan: ScheduledStepPlanner
}): ScheduledStepMaintainer {
  return async (uow, input) => {
    const settleAs = SETTLES_AS[input.toStatus]
    if (settleAs !== undefined) {
      const settled = await settleScheduledSteps(uow, {
        appointmentId: input.appointmentId,
        state: settleAs,
      })
      return {
        appointmentId: input.appointmentId,
        action: settleAs === 'superseded' ? 'supersede' : 'cancel',
        built: [],
        settled,
      }
    }
    if (input.toStatus !== 'confirmed') {
      // checked_in and in_progress change nothing: the appointment is still the same appointment at the
      // same time, and its reminders are still about it. `completed` likewise — by then every step has
      // come due and settled itself.
      return { appointmentId: input.appointmentId, action: 'none', built: [], settled: 0 }
    }
    const built = await buildScheduledSteps(uow, { appointmentId: input.appointmentId }, deps)
    return { appointmentId: input.appointmentId, action: 'build', built, settled: 0 }
  }
}

// --- the rebuild, when the reminder timing changes ----------------------------------------------

export interface RebuildResult {
  /** Appointments the pass touched. */
  readonly appointments: number
  readonly superseded: number
  readonly built: number
}

/**
 * Rebuilds every pending step of every forward booking under a new reminder set.
 *
 * The acceptance criterion is that a timing change reaches "all seeded forward bookings, not only bookings
 * created afterwards", and the reason it is written that way is that the obvious implementation does the
 * opposite: a new default applied at confirmation time changes nothing about the book already taken, and
 * the salon discovers it a week later when half its customers got a 24-hour reminder and half got a
 * 48-hour one.
 *
 * So the pass is over the appointments, not over the steps: an appointment with NO steps at all — one
 * created already `confirmed` by `createBooking`, which never transitions into that status — is picked up
 * by the same sweep, which is the second half of the same criterion.
 *
 * `fromIso` is the horizon: only appointments that have not started yet. A step for a treatment already
 * delivered has nothing to rebuild, and rewriting the settled history of the past book would be a pass
 * that changed rows nobody asked it to.
 */
export async function rebuildScheduledSteps(
  uow: UnitOfWork,
  input: { readonly fromIso: string; readonly toIso?: string },
  deps: { readonly plan?: ScheduledStepPlanner },
): Promise<RebuildResult> {
  if (typeof deps?.plan !== 'function') {
    throw refusal(
      'invariant_violated',
      'step_plan_not_derived',
      'no step planner was supplied, so the rebuild had no keys to write. Without one this pass would ' +
        'supersede every pending reminder in the forward book and insert nothing in their place.',
    )
  }
  const appointments = await uow.sql<{ id: string }[]>`
    select id::text as id
      from appointment
     where holds_resources
       and lower(period) > ${input.fromIso}::timestamptz
       and (${input.toIso ?? null}::timestamptz is null
            or lower(period) < ${input.toIso ?? null}::timestamptz)
     order by lower(period), id
     for update
  `
  let superseded = 0
  let built = 0
  for (const row of appointments) {
    // Superseded FIRST, then rebuilt. The partial unique index allows one pending row per (appointment,
    // step type), so a build that ran first would conflict with the row it is replacing and do nothing —
    // silently, because the insert is `on conflict do nothing`. This order is the difference between a
    // rebuild and a no-op that reports success.
    superseded += await settleScheduledSteps(uow, {
      appointmentId: row.id,
      state: 'superseded',
    })
    built += (await buildScheduledSteps(uow, { appointmentId: row.id }, deps)).length
  }
  return { appointments: appointments.length, superseded, built }
}

// --- the drain ----------------------------------------------------------------------------------

/** The step and its appointment, read together under the step's row lock. */
export interface ClaimedStep {
  readonly id: string
  readonly appointmentId: string
  readonly bookingId: string
  readonly stepType: string
  readonly invalidationKey: string
  readonly sendAtIso: string
  readonly state: string
  readonly startsAtMs: number
  readonly endsAtMs: number
  readonly holdsResources: boolean
  /** E.164, from the booking's customer. Null when the booking has no customer row. */
  readonly recipient: string | null
  readonly locale: string
}

/**
 * Locks one step and reads the appointment as it is NOW.
 *
 * ONE statement, and that is what makes the invalidation check sound: reading the step and then reading
 * the appointment would leave a window in which the appointment moved between the two, and the key
 * comparison would then be made against a period that had already changed.
 *
 * `for no key update of s` rather than `for update`: the weaker mode is enough — it blocks another writer
 * of this row, which is all the drain needs — and `of s` is load-bearing, because the statement LEFT JOINs
 * `customer` and Postgres refuses a row lock on the nullable side of an outer join. Nothing else contends
 * for a step row anyway (the lifecycle settles steps under the appointment's own lock), so the lock is
 * held only for the length of the send.
 */
export async function claimScheduledStep(
  sql: Sql,
  stepId: string,
): Promise<ClaimedStep | undefined> {
  const [row] = await sql<
    {
      id: string
      appointment_id: string
      booking_id: string
      step_type: string
      invalidation_key: string
      send_at: Date
      state: string
      starts_at: Date
      ends_at: Date
      holds_resources: boolean
      recipient: string | null
      locale: string | null
    }[]
  >`
    select s.id::text as id, s.appointment_id::text as appointment_id,
           a.booking_id::text as booking_id, s.step_type, s.invalidation_key, s.send_at,
           s.state::text as state, lower(a.period) as starts_at, upper(a.period) as ends_at,
           a.holds_resources, c.phone_e164 as recipient, c.locale
      from scheduled_step s
      join appointment a on a.id = s.appointment_id
      join booking b on b.id = a.booking_id
      left join customer c on c.id = b.customer_id
     where s.id = ${stepId}
       for no key update of s
  `
  if (row === undefined) return undefined
  return {
    id: row.id,
    appointmentId: row.appointment_id,
    bookingId: row.booking_id,
    stepType: row.step_type,
    invalidationKey: row.invalidation_key,
    sendAtIso: row.send_at.toISOString(),
    state: row.state,
    startsAtMs: row.starts_at.getTime(),
    endsAtMs: row.ends_at.getTime(),
    holdsResources: row.holds_resources,
    recipient: row.recipient,
    // 'en' is the fallback a customer row cannot supply, not a guess about the person: `customer.locale`
    // is NOT NULL, so this is only reachable through the LEFT JOIN above.
    locale: row.locale ?? 'en',
  }
}

/** Records the send. The message id is the evidence, and the row refuses `sent` without one. */
export async function recordStepSent(
  uow: UnitOfWork,
  input: {
    readonly stepId: string
    readonly messageId: string
    readonly stalenessNote: string | null
    readonly atIso: string
  },
): Promise<void> {
  const rows = await uow.sql<{ id: string }[]>`
    update scheduled_step
       set state = 'sent', message_id = ${input.messageId},
           staleness_note = ${input.stalenessNote}, settled_at = ${input.atIso}::timestamptz
     where id = ${input.stepId} and state = 'pending'
    returning id
  `
  if (rows.length !== 1) {
    throw refusal(
      'conflict',
      'step_not_settled',
      `step ${input.stepId} was not pending when the send came back, so the message it produced has no ` +
        'step to belong to. The row is locked for the length of the drain, so this means the step was ' +
        'settled outside it.',
      { stepId: input.stepId, messageId: input.messageId },
    )
  }
}

/** Records the skip, with its reason code. Never a silent no-op: see 0051's `settled_at`. */
export async function recordStepSkipped(
  uow: UnitOfWork,
  input: { readonly stepId: string; readonly reason: string; readonly atIso: string },
): Promise<void> {
  const rows = await uow.sql<{ id: string }[]>`
    update scheduled_step
       set state = 'skipped', skipped_reason = ${input.reason},
           settled_at = ${input.atIso}::timestamptz
     where id = ${input.stepId} and state = 'pending'
    returning id
  `
  if (rows.length !== 1) {
    throw refusal(
      'conflict',
      'step_not_settled',
      `step ${input.stepId} was not pending when the drain tried to skip it as '${input.reason}'.`,
      { stepId: input.stepId, reason: input.reason },
    )
  }
}

/** Every pending step whose send instant has passed, oldest first. The sweep's work list. */
export async function dueScheduledSteps(
  sql: Sql,
  input: { readonly atIso: string; readonly limit?: number },
): Promise<readonly { readonly id: string; readonly sendAtIso: string }[]> {
  const rows = await sql<{ id: string; send_at: Date }[]>`
    select id::text as id, send_at
      from scheduled_step
     where state = 'pending' and send_at <= ${input.atIso}::timestamptz
     order by send_at, id
     limit ${input.limit ?? 500}
  `
  return rows.map((row) => ({ id: row.id, sendAtIso: row.send_at.toISOString() }))
}

/** Every step of one appointment, for a caller that wants to assert on the set. */
export async function scheduledStepsFor(
  sql: Sql,
  appointmentId: string,
): Promise<
  readonly {
    readonly id: string
    readonly stepType: string
    readonly invalidationKey: string
    readonly state: string
    readonly sendAtIso: string
    readonly messageId: string | null
    readonly stalenessNote: string | null
    readonly skippedReason: string | null
    readonly settledAtIso: string | null
  }[]
> {
  const rows = await sql<
    {
      id: string
      step_type: string
      invalidation_key: string
      state: string
      send_at: Date
      message_id: string | null
      staleness_note: string | null
      skipped_reason: string | null
      settled_at: Date | null
    }[]
  >`
    select id::text as id, step_type, invalidation_key, state::text as state, send_at,
           message_id::text as message_id, staleness_note, skipped_reason, settled_at
      from scheduled_step
     where appointment_id = ${appointmentId}
     order by send_at, step_type, id
  `
  return rows.map((row) => ({
    id: row.id,
    stepType: row.step_type,
    invalidationKey: row.invalidation_key,
    state: row.state,
    sendAtIso: row.send_at.toISOString(),
    messageId: row.message_id,
    stalenessNote: row.staleness_note,
    skippedReason: row.skipped_reason,
    settledAtIso: row.settled_at?.toISOString() ?? null,
  }))
}

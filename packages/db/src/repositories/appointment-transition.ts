import { AppError } from '@berelax/shared'
import type { Actor, ActorKind, RequestContext } from '../audit.ts'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'
import { withUnitOfWork } from '../tx.ts'
import type { ScheduledStepMaintainer, ScheduledStepMaintenance } from './scheduled-step.ts'

/**
 * The write half of the appointment lifecycle (B-LIFE-01).
 *
 * One transition is one transaction, and four records commit together or none of them do: the
 * `appointment.status` update, the `appointment_status_history` row the 0024 trigger appends, the
 * `audit_event` row and exactly one `outbox_event`. Any of those without the others is a defect whose
 * evidence is precisely the record that is missing (ADR 0008).
 *
 * ## The rule is injected, because `packages/db` may not import `packages/core`
 *
 * Which transitions are legal, who may perform each one, what each emits and what a repeat does is
 * `packages/core/src/lifecycle/transitions.ts` — data, typed over the status union so an unhandled status
 * fails `pnpm typecheck`. The dependency runs core <- db, so the decision arrives as a function
 * ({@link TransitionDecider}) and this module supplies it with the status it read under the row lock and
 * the role the session carries. `decideAppointmentTransition satisfies TransitionDecider` in
 * `packages/fixtures/src/appointment-lifecycle.itest.ts` is what proves the two declarations of that seam
 * agree; a caller that supplies no decider is refused with `transition_not_decided` rather than
 * defaulting to "the move was probably fine", which is the same fail-closed shape `createBooking` takes
 * for its slot re-check.
 *
 * The role check is therefore **the F07 policy layer's**, reached through the injected decider. There is
 * no `if (role === 'receptionist')` anywhere in this file, and that is the point: a hand-rolled check at
 * a call site is a second copy of the matrix, and the second copy is the one that falls behind.
 *
 * ## The appointment row is locked before its status is read
 *
 * `select … for update` on the appointment, then the decision, then the update. Without the lock the
 * status is read, judged and written across three statements, and two receptionists completing the same
 * appointment both read `in_progress`, both decide the move is legal and both write — which is how a
 * terminal state ends up reached twice and the revenue event emitted against a second reading. The lock
 * also serialises the history read-back below, which is what makes `id > highWater` exact.
 *
 * ## The history row is read back, not assumed
 *
 * 0024 writes the chain from a trigger so "a transition without a history row is not reachable", and 0046
 * gives that trigger the actor, role and reason through transaction-local settings (the mechanism 0036
 * introduced for the settings justification, and for the same reason: a trigger cannot see a value that
 * is not a column on the table it fires for).
 *
 * A `set_config` that was never called, or called with the wrong key, produces a perfectly valid row with
 * three NULLs in it — and nothing would report that. 0036 is the recorded case of exactly this going
 * unnoticed: 8,202 history rows with no justification, because the value was demanded of the operator,
 * validated and then dropped on the floor. So this function reads back the rows the trigger appended for
 * this appointment and refuses with `transition_not_recorded` unless there is exactly one and it carries
 * exactly this actor, role and reason. It is not belt and braces; it is the only thing standing between a
 * silent trigger change and an unattributed chain.
 *
 * ## Exactly one event, and its key is the business fact
 *
 * The outbox key is `${eventType}:${appointmentId}`, which is unique because the machine is acyclic: no
 * transition returns to a state already left, so each status is entered at most once per appointment
 * (`appointmentLifecycleViolations` refuses a cycle for this reason). A retry of the same operation
 * therefore cannot enqueue a second copy, and `publishEvent` returning `null` — the key already present —
 * means this exact fact was already recorded, which for a legal transition is a contradiction and is
 * refused with `event_not_enqueued` rather than committing a state change nobody will hear about.
 */

/** Every reason a transition is refused, as a value. Callers branch on these, never on prose. */
export const TRANSITION_REFUSALS = [
  /** No appointment with that id. */
  'appointment_not_found',
  /** The pair is not in the transition table (the decider's `illegal_transition`). */
  'illegal_transition',
  /** The pair is legal and this role may not perform it. The F07 policy layer's answer. */
  'transition_forbidden',
  /** A repeat of a transition whose state declares the repeat an error rather than a no-op. */
  'already_in_status',
  /** The transition declares a written reason mandatory and none was given. */
  'reason_required',
  /** No decider was injected, so nothing applied the transition table. Fail closed. */
  'transition_not_decided',
  /** The trigger did not append exactly one history row carrying this actor, role and reason. */
  'transition_not_recorded',
  /** The outbox already held this event, so the transition would commit without emitting one. */
  'event_not_enqueued',
] as const
export type TransitionRefusal = (typeof TRANSITION_REFUSALS)[number]

/**
 * The actor, as the transition records them.
 *
 * `role` is the F07 role the permission check consults, and it is separate from `kind` on purpose:
 * `audit_event` has recorded the KIND of actor since 0005 and has never held the role, and the role is
 * what says whether the move was authorised at all.
 */
export interface TransitionActor {
  readonly kind: ActorKind
  /**
   * The F07 role STORED on the history row — `owner`, `manager`, `receptionist`. One of the eight.
   *
   * `appointment_status_history_actor_role_known` (0046) restates `ROLES` as a CHECK, and
   * `packages/fixtures/src/appointment-lifecycle.itest.ts` asserts the accepted set equals `ROLES` exactly
   * in both directions — so this column cannot hold anything else, whatever a caller believes about who it
   * is. A non-interactive surface therefore records `system`, which is what that role is for:
   * "Background workers and agents. No interactive login exists for this role."
   */
  readonly role: string
  /**
   * The PRINCIPAL the permission check consults instead of the role, when the caller is not a member of
   * staff. B-UI-05's magic-link holder is the first.
   *
   * Two fields and not one, because they answer two questions and the database has room only for the
   * first. The role is what is RECORDED; the principal is what was AUTHORISED. Sending a principal id
   * through `role` was the first draft and it failed at the CHECK above — which was the constraint being
   * right: a history row is read by somebody asking which of the eight roles did this, and a ninth value in
   * that column would break every reader of it in order to record something the audit trail already
   * carries.
   *
   * `packages/core/src/access/principals/customer-link.ts` records why a magic-link holder is a principal
   * rather than a ninth role, and `decideAppointmentTransition` resolves either through the one
   * `principalCan` — so this adds a kind of CALLER and not a second authorisation policy. The principal
   * stays out of the history row deliberately: it belongs in {@link TransitionActor.label}, which is free
   * text, and in the `audit_event` row the same transaction writes.
   */
  readonly principal?: string
  readonly id?: string
  readonly label?: string
}

/** One legal transition, as the decider describes it. Mirrors `AppointmentTransition` in core. */
export interface DecidedTransition {
  readonly from: string
  readonly to: string
  readonly permission: string
  readonly eventType: string
  /** True for the one transition that emits revenue. The payload carries money only when it is set. */
  readonly emitsRevenue: boolean
  readonly reasonRequired: boolean
  readonly why: string
}

/**
 * The decider's answer. Three outcomes, and `no_op` is deliberately not a kind of `allowed`: a caller
 * that treated them alike would write a history row for a transition that did not happen, which is the
 * chain reading as activity where nothing occurred.
 */
export type TransitionDecision =
  | { readonly kind: 'allowed'; readonly transition: DecidedTransition }
  | { readonly kind: 'no_op'; readonly status: string; readonly why: string }
  | {
      readonly kind: 'refused'
      readonly refusal: TransitionRefusal
      readonly why: string
      readonly permittedRoles?: readonly string[]
    }

/**
 * `decideAppointmentTransition` from `@berelax/core`, injected.
 *
 * A function rather than an import because `packages/db` must never import `packages/core`. Strings
 * rather than the status union for the same reason — the vocabulary belongs to core, and duplicating it
 * here would be a second list to keep in step. The statuses this passes come from the `appointment_status`
 * column, and core refuses one it does not recognise rather than assuming it is safe.
 */
export type TransitionDecider = (
  from: string,
  to: string,
  role: string,
  reason: string | null,
) => TransitionDecision

export interface TransitionDeps {
  readonly decide: TransitionDecider
  /**
   * B-MSG-03's scheduled-step maintainer, injected.
   *
   * Every transition in the lifecycle comes through this function, which is what makes this the one seam
   * where "CONFIRMED creates the reminder set, RESCHEDULED supersedes it, CANCELLED_* and NO_SHOW settle
   * it" can be true without four call sites each remembering to do it. It runs inside the same
   * transaction as the status change, its history row, its audit row and its event: a reminder that
   * survived a rolled-back cancellation would be the bug from the other direction.
   *
   * OPTIONAL in the type, so that every caller written before B-MSG-03 compiles unchanged — and that
   * would be a permissive default if it were the only layer. It is not. 0051's deferred constraint
   * trigger refuses any transaction that COMMITS a pending step on an appointment which no longer holds
   * its resources, so omitting this does not silently leave a live reminder on a cancelled booking: it
   * fails, by name, naming the step and the appointment.
   */
  readonly steps?: ScheduledStepMaintainer
}

export interface TransitionInput {
  readonly appointmentId: string
  /** The state to move to, from the `appointment_status` enum. An unknown label is refused by core. */
  readonly to: string
  readonly actor: TransitionActor
  /** Why. Mandatory for the transitions the table declares, and never stored as `''`. */
  readonly reason?: string
  /**
   * Facts only the caller knows, merged into the audit row's `after` and into the outbox payload.
   *
   * Added for B-LIFE-03, which composes this function into a larger transaction: a reschedule knows the
   * old and new periods and the invalidation key of every scheduled step, and a late cancellation knows
   * the window it was judged against. None of those are readable from `appointment.status`, so the
   * alternative was a SECOND event of the same type carrying them — two rows for one business fact, with
   * a key that collides with the one this function derives.
   *
   * The canonical keys always win: this object is spread FIRST in both places, so a caller cannot
   * overwrite `toStatus` or `actor_role` with something the transition did not do.
   *
   * Keys are `snake_case`, because the same object is written into `audit_event.after` and that table has
   * spelled its facts that way since 0005. The transition's own payload keys stay `camelCase`, so a
   * payload that carries both reads as two contributors — which is exactly what it is.
   */
  readonly extra?: Readonly<Record<string, unknown>>
}

/** The appended history row, as it was stored. Read back rather than reconstructed. */
export interface TransitionHistoryRow {
  readonly id: string
  readonly fromStatus: string | null
  readonly toStatus: string
  readonly occurredAt: Date
  readonly actorKind: string | null
  readonly actorId: string | null
  readonly actorLabel: string | null
  readonly actorRole: string | null
  readonly reason: string | null
}

export type TransitionResult =
  | {
      readonly kind: 'transitioned'
      readonly appointmentId: string
      readonly from: string
      readonly to: string
      readonly eventType: string
      /** The outbox row this transition enqueued. Exactly one, in the same transaction. */
      readonly eventId: string
      readonly history: TransitionHistoryRow
      /** What this move did to the appointment's scheduled steps. Absent when no maintainer was given. */
      readonly steps?: ScheduledStepMaintenance
    }
  | {
      /** The state was already the one asked for and the table declares the repeat idempotent. */
      readonly kind: 'no_op'
      readonly appointmentId: string
      readonly status: string
      readonly why: string
    }

const refusal = (
  kind: 'conflict' | 'validation' | 'forbidden' | 'not_found' | 'invariant_violated',
  name: TransitionRefusal,
  message: string,
  extra: Record<string, unknown> = {},
): AppError =>
  new AppError(kind, `${name}: ${message}`, {
    userFacing: true,
    details: { refusal: name, ...extra },
  })

/** The refusal an error carries, or `null`. Lets a caller branch without matching on the message. */
export function transitionRefusalOf(err: unknown): TransitionRefusal | null {
  const name = err instanceof AppError ? err.details['refusal'] : undefined
  return TRANSITION_REFUSALS.includes(name as TransitionRefusal)
    ? (name as TransitionRefusal)
    : null
}

/** The `AppError.kind` each refusal is reported as. A refusal is never a 500. */
const REFUSAL_KIND: Readonly<
  Record<
    TransitionRefusal,
    'conflict' | 'validation' | 'forbidden' | 'not_found' | 'invariant_violated'
  >
> = Object.freeze({
  appointment_not_found: 'not_found',
  illegal_transition: 'conflict',
  transition_forbidden: 'forbidden',
  already_in_status: 'conflict',
  reason_required: 'validation',
  transition_not_decided: 'invariant_violated',
  transition_not_recorded: 'invariant_violated',
  event_not_enqueued: 'invariant_violated',
})

interface AppointmentRow {
  readonly id: string
  readonly booking_id: string
  readonly status: string
  readonly trading_date: string
  readonly gross_price_fils: string
  readonly net_fils: string
  readonly vat_fils: string
  readonly vat_rate_bp: number
}

interface HistoryRow {
  readonly id: string
  readonly from_status: string | null
  readonly to_status: string
  readonly occurred_at: Date
  readonly actor_kind: string | null
  readonly actor_id: string | null
  readonly actor_label: string | null
  readonly actor_role: string | null
  readonly reason: string | null
}

const rowToHistory = (row: HistoryRow): TransitionHistoryRow => ({
  id: row.id,
  fromStatus: row.from_status,
  toStatus: row.to_status,
  occurredAt: row.occurred_at,
  actorKind: row.actor_kind,
  actorId: row.actor_id,
  actorLabel: row.actor_label,
  actorRole: row.actor_role,
  reason: row.reason,
})

/** A reason counts as given only when it is more than whitespace; `''` is never stored (0046). */
const statedReason = (reason: string | undefined): string | null => {
  const trimmed = reason?.trim() ?? ''
  return trimmed === '' ? null : trimmed
}

/**
 * Hands the actor, the role and the reason to the 0046 trigger.
 *
 * Transaction-local (`set_config(…, true)`), so an actor cannot leak into the next statement on a pooled
 * connection — which a column on `appointment` or a session-level variable would both allow. `set_config`
 * cannot store SQL NULL, so absent is `''` and the trigger normalises it back to NULL: a row must not
 * read as though somebody with an empty name had acted.
 */
async function announceActor(
  uow: UnitOfWork,
  actor: TransitionActor,
  reason: string | null,
): Promise<void> {
  await uow.sql`
    select set_config('berelax.transition_actor_kind', ${actor.kind}, true),
           set_config('berelax.transition_actor_id', ${actor.id ?? ''}, true),
           set_config('berelax.transition_actor_label', ${actor.label ?? ''}, true),
           set_config('berelax.transition_actor_role', ${actor.role}, true),
           set_config('berelax.transition_reason', ${reason ?? ''}, true)
  `
}

/**
 * The rows the trigger appended for this appointment inside this transaction.
 *
 * `id > highWater` is exact rather than approximate because the appointment row is locked: no other
 * transaction can append a row for this appointment while this one holds it, and
 * `appointment_status_history.id` is `generated always as identity`.
 *
 * Both the predicate and the ordering name the column QUALIFIED, because `id::text as id` in the select
 * list creates an output column called `id` and `ORDER BY` resolves an output name before a table column —
 * so the unqualified form sorts the chain as text, putting '10' before '9'.
 */
async function appendedHistory(
  uow: UnitOfWork,
  appointmentId: string,
  highWater: string,
): Promise<readonly TransitionHistoryRow[]> {
  const rows = await uow.sql<HistoryRow[]>`
    select id::text as id, from_status::text as from_status, to_status::text as to_status,
           occurred_at, actor_kind, actor_id::text as actor_id, actor_label, actor_role, reason
      from appointment_status_history
     where appointment_id = ${appointmentId} and appointment_status_history.id > ${highWater}::bigint
     order by appointment_status_history.id
  `
  return rows.map(rowToHistory)
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
 * Asserts the chain recorded this transition, once, with its attribution.
 *
 * Every clause is a failure that has a precedent. More than one row means a second writer moved the same
 * appointment inside this transaction and the chain no longer describes one move; zero means the trigger
 * did not fire, which is what a `create or replace` that dropped the `elsif` looks like; and a NULL actor
 * means the `set_config` never reached the trigger — 0036's recorded failure, where a value was demanded,
 * validated and then dropped with nothing reporting it.
 */
function assertRecorded(
  appended: readonly TransitionHistoryRow[],
  args: {
    readonly from: string
    readonly to: string
    readonly actor: TransitionActor
    readonly reason: string | null
  },
): TransitionHistoryRow {
  const [row] = appended
  if (appended.length !== 1 || row === undefined) {
    throw refusal(
      'invariant_violated',
      'transition_not_recorded',
      `the status change appended ${appended.length} history rows; a transition appends exactly one. ` +
        'The chain is written by the 0024 trigger, so this means the trigger did not fire or something ' +
        'else moved the same appointment in this transaction.',
      { appended: appended.length },
    ) as never
  }
  const mismatch =
    row.fromStatus !== args.from ||
    row.toStatus !== args.to ||
    row.actorKind !== args.actor.kind ||
    row.actorRole !== args.actor.role ||
    row.reason !== args.reason ||
    row.actorId !== (args.actor.id ?? null)
  if (mismatch) {
    throw refusal(
      'invariant_violated',
      'transition_not_recorded',
      'the appended history row does not carry this transition and this actor. The actor, role and ' +
        'reason reach the trigger through the transaction-local berelax.transition_* settings (0046); ' +
        'a row with NULLs in them is a set_config that never arrived, and an unattributed chain is ' +
        'indistinguishable from a chain nobody wrote to.',
      {
        expected: { ...args, actorId: args.actor.id ?? null },
        stored: {
          from: row.fromStatus,
          to: row.toStatus,
          actorKind: row.actorKind,
          actorRole: row.actorRole,
          actorId: row.actorId,
          reason: row.reason,
        },
      },
    )
  }
  return row
}

/**
 * Moves one appointment, inside an existing unit of work. All four records, or none.
 *
 * Call it through {@link transitionAppointmentTx} unless the move is part of a larger transaction —
 * B-LIFE-03's reschedule and partial cancellation are exactly that case, which is why this half takes a
 * {@link UnitOfWork} rather than a connection.
 */
export async function transitionAppointment(
  uow: UnitOfWork,
  input: TransitionInput,
  deps: TransitionDeps,
): Promise<TransitionResult> {
  // Fail closed. A transition written without the table being consulted is a transition nobody judged,
  // and the permissive default is the one failure this whole module exists to prevent.
  if (typeof deps?.decide !== 'function') {
    throw refusal(
      'invariant_violated',
      'transition_not_decided',
      'no transition decider was supplied, so nothing applied the lifecycle table. ' +
        '`decideAppointmentTransition` from @berelax/core is the table; packages/db may not import it, ' +
        'so the caller injects it.',
    )
  }
  const reason = statedReason(input.reason)

  // FOR UPDATE, and before the status is read rather than after. A status read, judged and written
  // across three statements is a status two actors can move at once - both reading `in_progress`, both
  // deciding the completion is legal, both writing it - and a terminal state reached twice emits its
  // event against the second reading.
  const [appointment] = await uow.sql<AppointmentRow[]>`
    select id::text as id, booking_id::text as booking_id, status::text as status,
           trading_date::text as trading_date, gross_price_fils::text as gross_price_fils,
           net_fils::text as net_fils, vat_fils::text as vat_fils, vat_rate_bp
      from appointment where id = ${input.appointmentId}
       for update
  `
  if (appointment === undefined) {
    throw refusal(
      'not_found',
      'appointment_not_found',
      `no appointment with id ${input.appointmentId}`,
      { appointmentId: input.appointmentId },
    )
  }

  // The PRINCIPAL where there is one, the role otherwise. See {@link TransitionActor.principal}: the role
  // is what the history row stores and the principal is what the policy layer judges, and for a staff
  // caller they are the same string.
  const caller = input.actor.principal ?? input.actor.role
  const decision = deps.decide(appointment.status, input.to, caller, reason)
  if (decision.kind === 'refused') {
    throw refusal(REFUSAL_KIND[decision.refusal], decision.refusal, decision.why, {
      appointmentId: input.appointmentId,
      from: appointment.status,
      to: input.to,
      role: caller,
      ...(decision.permittedRoles === undefined
        ? {}
        : { permittedRoles: [...decision.permittedRoles] }),
    })
  }
  if (decision.kind === 'no_op') {
    // Nothing is written: no status update, so no history row (0024's
    // `appointment_status_history_is_a_change` would refuse one anyway), no audit row and no event. The
    // declared answer to a double-tap is yes, and yes to a repeat is not a second transition.
    return {
      kind: 'no_op',
      appointmentId: input.appointmentId,
      status: appointment.status,
      why: decision.why,
    }
  }

  const { transition } = decision
  const highWater = await historyHighWater(uow, input.appointmentId)
  await announceActor(uow, input.actor, reason)

  await uow.sql`
    update appointment set status = ${transition.to}::appointment_status
     where id = ${input.appointmentId}
  `

  const history = assertRecorded(await appendedHistory(uow, input.appointmentId, highWater), {
    from: transition.from,
    to: transition.to,
    actor: input.actor,
    reason,
  })

  await uow.audit.record({
    // The event type is the audit action: one name for one fact, so a reader looking for the
    // completion of this appointment finds the same string in both places.
    action: transition.eventType,
    entityType: 'appointment',
    entityId: input.appointmentId,
    operation: 'update',
    before: { status: transition.from },
    after: {
      // Spread FIRST so the canonical facts below win: a caller contributing what only it knows must not
      // be able to record a status the transition did not make.
      ...(input.extra ?? {}),
      status: transition.to,
      actor_role: input.actor.role,
      reason,
      history_id: history.id,
      booking_id: appointment.booking_id,
    },
  })

  const eventId = await uow.publish({
    eventType: transition.eventType,
    aggregateType: 'appointment',
    aggregateId: input.appointmentId,
    // Derived from the business fact, not from a random value: the machine is acyclic, so this status
    // is entered at most once per appointment and a retry cannot enqueue a second copy.
    idempotencyKey: `${transition.eventType}:${input.appointmentId}`,
    payload: {
      // Spread FIRST, for the reason the audit row above gives.
      ...(input.extra ?? {}),
      appointmentId: input.appointmentId,
      bookingId: appointment.booking_id,
      tradingDate: appointment.trading_date,
      fromStatus: transition.from,
      toStatus: transition.to,
      occurredAt: history.occurredAt.toISOString(),
      actorKind: input.actor.kind,
      actorRole: input.actor.role,
      actorId: input.actor.id ?? null,
      reason,
      // Money rides on the ONE transition that declares revenue, and the figures are the snapshot the
      // appointment already holds - strings, because `fils` is int8 and a double does not hold it
      // (ADR 0007). A confirmation carries no money because a confirmed booking is not money: the
      // allowlist in core refuses any other status declaring revenue, and the pair itest asserts this
      // payload has no money key for `appointment.confirmed`.
      ...(transition.emitsRevenue
        ? {
            money: {
              grossFils: appointment.gross_price_fils,
              netFils: appointment.net_fils,
              vatFils: appointment.vat_fils,
              vatRateBp: appointment.vat_rate_bp,
            },
          }
        : {}),
    },
  })
  if (eventId === null) {
    // `publishEvent` answers null when the idempotency key is already present, which it treats as "this
    // business fact is already recorded". For a transition just judged legal that cannot be true, and
    // committing the state change without the event is the one outcome the outbox pattern exists to
    // prevent - so the whole transaction goes back.
    throw refusal(
      'invariant_violated',
      'event_not_enqueued',
      `the outbox already holds ${transition.eventType}:${input.appointmentId}, so this transition ` +
        'would commit with no event of its own. The key is derived from the business fact and the ' +
        'machine is acyclic, so a duplicate means the chain has been moved outside this API.',
      { eventType: transition.eventType },
    )
  }

  // After the event, so that a maintainer which throws rolls back the whole transition rather than
  // leaving a status change with no reminders and no event. It is the last thing this function does
  // because it is the only part of it that is about something other than the appointment row.
  const steps = await deps.steps?.(uow, {
    appointmentId: input.appointmentId,
    toStatus: transition.to,
  })

  return {
    kind: 'transitioned',
    appointmentId: input.appointmentId,
    from: transition.from,
    to: transition.to,
    eventType: transition.eventType,
    eventId,
    history,
    ...(steps === undefined ? {} : { steps }),
  }
}

/**
 * Moves one appointment in a transaction of its own.
 *
 * The audit writer needs the actor's kind, id and label; the decider needs their role. Both come from
 * one argument, because two would let a caller audit one actor and authorise another.
 */
export async function transitionAppointmentTx(
  sql: Sql,
  input: TransitionInput,
  deps: TransitionDeps,
  context: RequestContext = {},
): Promise<TransitionResult> {
  const actor: Actor = {
    kind: input.actor.kind,
    ...(input.actor.id === undefined ? {} : { id: input.actor.id }),
    ...(input.actor.label === undefined ? {} : { label: input.actor.label }),
  }
  return await withUnitOfWork(sql, actor, (uow) => transitionAppointment(uow, input, deps), context)
}

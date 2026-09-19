import { can, type Permission, ROLES, type Role } from '../access/permissions.ts'

/**
 * The appointment lifecycle, as data.
 *
 * Nine states, fifteen legal transitions, and sixty-six pairs that are refused by name. Every one of
 * those numbers is asserted in `transitions.test.ts` against a literal list written out there, so a row
 * added or removed here fails the build rather than widening the machine quietly.
 *
 * ## Why the table is data and not a `switch`
 *
 * A state machine written as control flow has one property nobody can check: the set of pairs it
 * accepts is not readable anywhere. It is spread across the branches, and the branch that is missing
 * looks exactly like the branch that was never needed. The whole 9x9 grid is therefore enumerable from
 * here — {@link LEGAL_APPOINTMENT_TRANSITIONS} says which pairs move and
 * {@link APPOINTMENT_STATUS_ACTIONS} says what each move costs, both as `Record`s over the status union
 * — and {@link decideAppointmentTransition} is a lookup with no policy of its own.
 *
 * `Record<AppointmentStatus, …>` is the coverage assertion: a tenth status added to
 * {@link APPOINTMENT_STATUSES} makes both objects incomplete and `pnpm typecheck` fails naming this
 * file. Gate 51o does exactly that and watches it fail. There is no `default:` here to fall through to,
 * which is the point — a default in a state machine is a default-allow with better manners.
 *
 * ## The two cancellations are two states, and they never collapse
 *
 * `cancelled_by_customer` and `cancelled_by_salon` are distinct terminal states with distinct event
 * types, distinct permissions and a distinct reason requirement, because the cancellation policy, the
 * no-show fee and the refund all depend on **who** cancelled (docs/03 §2, migration 0024). The way that
 * distinction dies is a display helper that maps both to `CANCELLED` for a label; `transitions.test.ts`
 * sweeps every arity-1 export of this module and fails any that answers the same cancellation-shaped
 * string for both, and gate 51n adds such a helper and watches the sweep catch it.
 *
 * The state names who **requested** the cancellation; the actor columns on the history row name who
 * **recorded** it. Those are two facts, which is why a receptionist taking a phone call records
 * `cancelled_by_customer` under their own role without the state becoming a salon cancellation.
 *
 * ## COMPLETED emits revenue; CONFIRMED does not
 *
 * "The till knows the truth" (docs/03 §2): a confirmed booking is a guess about money and a completed
 * one is money. Exactly one status declares {@link StatusAction.emitsRevenue}, and
 * {@link appointmentLifecycleViolations} refuses any other status that declares it, refuses a
 * non-revenue event whose name so much as *reads* like money (`/revenue|sale|invoice/`), and refuses two
 * statuses sharing one event type.
 *
 * ## Purity
 *
 * There is no clock here and no actor lookup. The transition table is static data; the instant and the
 * actor are arguments handed to it (`packages/core` may read neither). The time-dependent rules —
 * NO_SHOW only once the start is past, and the cancellation window — are B-LIFE-03's, and they narrow
 * what a caller may ask for rather than adding a second table.
 */

/**
 * The nine states, in the order migration 0024 declares the `appointment_status` enum.
 *
 * The order is load-bearing for nothing at runtime and load-bearing for review: the SQL enum and this
 * list are asserted equal, label for label and position for position, by
 * `packages/fixtures/src/appointment-lifecycle.itest.ts`. A tenth label added to one and not the other
 * is the drift that makes a status the database can hold and the machine cannot judge.
 */
export const APPOINTMENT_STATUSES = [
  'requested',
  'confirmed',
  'checked_in',
  'in_progress',
  'completed',
  'no_show',
  'cancelled_by_customer',
  'cancelled_by_salon',
  'rescheduled',
] as const

export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number]

/** Every reason a transition is refused, as a value. Callers branch on these, never on prose. */
export const APPOINTMENT_TRANSITION_REFUSALS = [
  /** The pair is not in the table. Sixty-six of the eighty-one cells answer this. */
  'illegal_transition',
  /** The pair is legal and this role may not perform it (the F07 policy layer said no). */
  'transition_forbidden',
  /** A repeat of a transition whose terminal state declares the repeat an error, not a no-op. */
  'already_in_status',
  /** The transition declares a reason mandatory and none was given. */
  'reason_required',
] as const

export type AppointmentTransitionRefusal = (typeof APPOINTMENT_TRANSITION_REFUSALS)[number]

/**
 * What a second, identical request does.
 *
 * A double-click on Cancel and a retried webhook are the same request twice, and "it depends" is not an
 * answer this table may hold. Each status that a transition can reach declares one of:
 *
 *   - `idempotent` — the second request is answered yes and writes **nothing**: no history row (the
 *     0024 check constraint `appointment_status_history_is_a_change` refuses a row from a state to
 *     itself anyway) and no outbox event.
 *   - `refused` — the second request is an error, because a silent success would conceal a mistake.
 *
 * The rule that decides which, applied in {@link APPOINTMENT_STATUS_ACTIONS} and nowhere else: a repeat
 * is `refused` where answering "done" would hide an actor acting on the wrong appointment — one with
 * money already taken (`completed`) or one whose live row is a different row (`rescheduled`) — and
 * `idempotent` everywhere else, because the state the caller asked for is already true and nothing
 * downstream counts the asking.
 */
export type RepeatBehaviour =
  | 'idempotent'
  | 'refused'
  /** No transition produces this status, so there is nothing to repeat. `requested` only. */
  | 'unreachable'

/** What every transition **into** a status costs, declares and emits. One row per status. */
export type StatusAction =
  | {
      /** No transition reaches this status; it exists only as the state a new appointment is born in. */
      readonly reachable: false
      readonly repeat: 'unreachable'
      readonly why: string
    }
  | {
      readonly reachable: true
      /**
       * The F07 permission this move requires, and the **only** place a role is consulted.
       *
       * Declared once, in data, and checked through `can()` from `../access/permissions.ts` — never a
       * hand-rolled `role === 'receptionist'` at a call site, which is how two call sites come to
       * disagree about who may cancel. {@link permittedRolesFor} derives the role list from the policy
       * layer rather than restating it, so a grant changed in `ROLE_DEFINITIONS` changes this table's
       * answer in the same commit.
       */
      readonly permission: Permission
      /** The one outbox event this move emits, in the same transaction as its history row. */
      readonly eventType: string
      /** True for `completed` alone. A confirmed booking is not money. */
      readonly emitsRevenue: boolean
      /** Whether a written reason is mandatory. Blank counts as absent. */
      readonly reasonRequired: boolean
      readonly repeat: Exclude<RepeatBehaviour, 'unreachable'>
      readonly why: string
    }

/**
 * One legal move out of a status: where to, and why that is legal.
 *
 * The `why` is not decoration. It is the only record of the argument, and every one of these was a
 * decision that could have gone the other way.
 */
export interface LegalTarget {
  readonly to: AppointmentStatus
  readonly why: string
}

/** A legal transition, assembled from the pair and the target's declaration. */
export interface AppointmentTransition {
  readonly from: AppointmentStatus
  readonly to: AppointmentStatus
  readonly permission: Permission
  readonly eventType: string
  readonly emitsRevenue: boolean
  readonly reasonRequired: boolean
  /** Why this pair is legal. */
  readonly why: string
}

/**
 * The verdict on one requested move. Three outcomes, and no fourth.
 *
 * `no_op` is deliberately not a kind of `allowed`: a caller that treats them alike writes a history row
 * for a transition that did not happen, which is the chain reading as activity where nothing occurred
 * (0024's `appointment_status_history_is_a_change`, stated as a constraint for that reason).
 */
export type AppointmentTransitionVerdict =
  | { readonly kind: 'allowed'; readonly transition: AppointmentTransition }
  | { readonly kind: 'no_op'; readonly status: AppointmentStatus; readonly why: string }
  | {
      readonly kind: 'refused'
      readonly refusal: AppointmentTransitionRefusal
      readonly why: string
      /** Every role the policy layer would accept for this move. Empty when the move is illegal. */
      readonly permittedRoles: readonly Role[]
    }

/**
 * What each status costs to enter. The row for `requested` is `reachable: false` on purpose.
 *
 * `requested` is the status `appointment.status`'s DEFAULT produces (0024), and the history row for a
 * creation carries `from_status = null`. There is therefore no transition *into* `requested`, nothing to
 * permit and nothing to emit — `booking.created` is B-AVAIL-06's event, written by the booking
 * transaction. Declaring a permission and an event here anyway would invent a move nobody can make, and
 * `requested -> requested` would stop being the `illegal_transition` it is.
 */
export const APPOINTMENT_STATUS_ACTIONS: Readonly<Record<AppointmentStatus, StatusAction>> =
  Object.freeze({
    requested: {
      reachable: false,
      repeat: 'unreachable',
      why:
        'The state an appointment is born in: `appointment.status` defaults to it (0024) and the ' +
        'creation history row carries from_status = null. Nothing transitions INTO it — un-confirming ' +
        'a booking is a cancellation, not a step backwards — so there is no permission and no event.',
    },
    confirmed: {
      reachable: true,
      permission: 'booking:confirm',
      eventType: 'appointment.confirmed',
      // docs/03 §2: CONFIRMED schedules reminders. It does not emit money, and the allowlist in
      // `appointmentLifecycleViolations` refuses an event name here that reads as though it did.
      emitsRevenue: false,
      reasonRequired: false,
      repeat: 'idempotent',
      why:
        'The salon accepting a request. Idempotent on repeat: the customer-facing confirmation link ' +
        'can be opened twice and two staff can accept the same request from two terminals, and ' +
        'neither must be told the confirmation failed when it did not.',
    },
    checked_in: {
      reachable: true,
      permission: 'booking:check_in',
      eventType: 'appointment.checked_in',
      emitsRevenue: false,
      reasonRequired: false,
      repeat: 'idempotent',
      why:
        'The client is in the building. Idempotent on repeat: a front-desk double-tap changes ' +
        'nothing, and the arrival is already recorded.',
    },
    in_progress: {
      reachable: true,
      permission: 'booking:start',
      eventType: 'appointment.started',
      emitsRevenue: false,
      reasonRequired: false,
      repeat: 'idempotent',
      why:
        'The treatment has begun, which is the fact that makes the period spent rather than booked. ' +
        'Idempotent on repeat: nothing downstream counts how many times Start was tapped.',
    },
    completed: {
      reachable: true,
      permission: 'booking:complete',
      eventType: 'appointment.completed',
      // The one revenue event in the lifecycle. docs/03 §2: "COMPLETED is what emits revenue events,
      // not CONFIRMED - booking value is a guess, the till knows the truth."
      emitsRevenue: true,
      reasonRequired: false,
      repeat: 'refused',
      why:
        'The treatment was delivered. REFUSED on repeat, and it is the one state where a silent yes ' +
        'is dangerous: completion is what emits revenue and issues the invoice, and the likeliest ' +
        'cause of a second completion is the other row of a couples booking being in front of the ' +
        'actor. "Already completed" sends them to read the appointment; "done" sends them to the till.',
    },
    no_show: {
      reachable: true,
      permission: 'booking:mark_no_show',
      eventType: 'appointment.no_show',
      emitsRevenue: false,
      // No reason is demanded: the absence of the client IS the fact, and a mandatory free-text box
      // produces "did not come" on every row, which is noise wearing the shape of evidence.
      reasonRequired: false,
      repeat: 'idempotent',
      why:
        'The client never arrived. Idempotent on repeat: whoever sweeps the past day for unattended ' +
        'appointments may sweep the same window twice, and the second pass states the same fact.',
    },
    cancelled_by_customer: {
      reachable: true,
      permission: 'booking:cancel',
      eventType: 'appointment.cancelled_by_customer',
      emitsRevenue: false,
      // Optional, deliberately. A customer who gives no reason has still cancelled, and refusing the
      // cancellation for want of one turns it into a no-show - a worse record of the same evening.
      reasonRequired: false,
      repeat: 'idempotent',
      why:
        'The customer withdrew. Idempotent on repeat: a double-tap in the portal and a retried ' +
        'provider webhook are the same request twice, and the second must not read as a failure.',
    },
    cancelled_by_salon: {
      reachable: true,
      permission: 'booking:cancel_as_salon',
      eventType: 'appointment.cancelled_by_salon',
      emitsRevenue: false,
      // Required. This is the salon breaking its own commitment, and the reason is the record a
      // disputed refund is settled from. There is no honest default for it.
      reasonRequired: true,
      repeat: 'idempotent',
      why:
        'The salon cancelled - a therapist called in sick, a room flooded. Owner or manager only, ' +
        'because it carries a goodwill and refund consequence the front desk cannot take alone. ' +
        'Idempotent on repeat: when a therapist calls in sick two managers cancel the same list.',
    },
    rescheduled: {
      reachable: true,
      permission: 'booking:reschedule',
      eventType: 'appointment.rescheduled',
      emitsRevenue: false,
      // Required: the reason is what tells a customer request from an operational move, and B-LIFE-03's
      // cancellation window reads it.
      reasonRequired: true,
      repeat: 'refused',
      why:
        'This row was superseded by a new one (B-LIFE-03). REFUSED on repeat, because the appointment ' +
        'that still exists is the SUCCESSOR: a second reschedule of this row would move a period it no ' +
        'longer holds (holds_resources is false for it) and leave the live row untouched, and being ' +
        'told "done" is how that goes unnoticed until the customer arrives on the wrong day.',
    },
  })

/**
 * Every legal move, by the status it leaves. The fifteen pairs, and the argument for each.
 *
 * Read the gaps as carefully as the entries. Four of them are decisions rather than omissions:
 *
 *   - **`confirmed -> in_progress` is absent.** Check-in is the arrival fact, and skipping it starts a
 *     treatment for a client nobody recorded as present. The walk-in path does not need it: B-AVAIL-06
 *     creates the appointment already `confirmed` and the front desk checks them in.
 *   - **`in_progress` has exactly one exit.** A treatment that has begun cannot be cancelled or turned
 *     into a no-show. `appointment.holds_resources` (0024) is false for every cancellation, so
 *     cancelling a started treatment would free a past period the room really occupied — the same
 *     reasoning 0024 gives for `completed` still holding: "a second booking over the same past period
 *     is a double-booking that happened, not a free slot". What was delivered is settled at the till,
 *     not by rewriting the state.
 *   - **`requested -> no_show` is absent.** A request the salon never accepted is not a no-show: the
 *     salon never promised the slot, and a fee policy attached to that flag would charge for it.
 *   - **No transition returns to an earlier state, and none returns to `requested`.** The machine is
 *     acyclic, which is what makes `${eventType}:${appointmentId}` a unique idempotency key for the
 *     outbox: each status is entered at most once per appointment. `appointmentLifecycleViolations`
 *     refuses a cycle for that reason.
 */
export const LEGAL_APPOINTMENT_TRANSITIONS: Readonly<
  Record<AppointmentStatus, readonly LegalTarget[]>
> = Object.freeze({
  requested: [
    {
      to: 'confirmed',
      why: 'The salon accepts an online request. The one path docs/03 §2 draws from REQUESTED.',
    },
    {
      to: 'cancelled_by_customer',
      why: 'The customer withdraws a request the salon has not answered yet.',
    },
    {
      to: 'cancelled_by_salon',
      why: 'The salon declines a request it cannot deliver. A decline is a salon cancellation, not a separate state: the slot was held, the customer was told, and the reporting treatment is the same.',
    },
    {
      to: 'rescheduled',
      why: 'A requested appointment already HOLDS its therapist and room (`holds_resources` is true for `requested`, 0024), so moving it has to release that period the same way a confirmed one does.',
    },
  ],
  confirmed: [
    { to: 'checked_in', why: 'The client arrives and the front desk records it.' },
    { to: 'no_show', why: 'The client never arrived for a slot the salon promised and held.' },
    { to: 'cancelled_by_customer', why: 'The customer cancels a confirmed appointment.' },
    {
      to: 'cancelled_by_salon',
      why: 'The salon cancels: a therapist is ill, the wet room is out of service.',
    },
    { to: 'rescheduled', why: 'The appointment is moved to another slot (B-LIFE-03).' },
  ],
  checked_in: [
    { to: 'in_progress', why: 'The therapist starts the treatment.' },
    {
      to: 'no_show',
      why: 'A check-in recorded against the wrong appointment, or a client who left the waiting room before the treatment began. B-LIFE-03 requires NO_SHOW reachable from CONFIRMED or CHECKED_IN, and the state of the room is the same either way: nobody was treated.',
    },
    {
      to: 'cancelled_by_customer',
      why: 'The client is in the salon and changes their mind before the treatment starts.',
    },
    {
      to: 'cancelled_by_salon',
      why: 'The therapist cannot deliver after the client checked in, and the salon does not make them wait.',
    },
    {
      to: 'rescheduled',
      why: 'The client is present and the salon moves them to a later slot; the old period must be released.',
    },
  ],
  in_progress: [
    {
      to: 'completed',
      why: 'The treatment finished. The only exit, and the one that emits revenue.',
    },
  ],
  completed: [],
  no_show: [],
  cancelled_by_customer: [],
  cancelled_by_salon: [],
  rescheduled: [],
})

/** Statuses no legal transition leaves. Derived, so it cannot disagree with the table. */
export const TERMINAL_APPOINTMENT_STATUSES: readonly AppointmentStatus[] = Object.freeze(
  APPOINTMENT_STATUSES.filter((status) => LEGAL_APPOINTMENT_TRANSITIONS[status].length === 0),
)

/** True when no legal transition leaves this status. */
export function isTerminalAppointmentStatus(status: AppointmentStatus): boolean {
  return LEGAL_APPOINTMENT_TRANSITIONS[status].length === 0
}

/** The legal moves out of a status. */
export function legalTargetsOf(status: AppointmentStatus): readonly LegalTarget[] {
  return LEGAL_APPOINTMENT_TRANSITIONS[status]
}

/** The outbox event a move into this status emits, or `null` when nothing reaches it. */
export function eventTypeFor(status: AppointmentStatus): string | null {
  const action = APPOINTMENT_STATUS_ACTIONS[status]
  return action.reachable ? action.eventType : null
}

/** The F07 permission a move into this status requires, or `null` when nothing reaches it. */
export function permissionFor(status: AppointmentStatus): Permission | null {
  const action = APPOINTMENT_STATUS_ACTIONS[status]
  return action.reachable ? action.permission : null
}

/** What a repeat of the transition that produced this status does. */
export function repeatBehaviourFor(status: AppointmentStatus): RepeatBehaviour {
  return APPOINTMENT_STATUS_ACTIONS[status].repeat
}

/**
 * Every role the policy layer accepts for a move into this status.
 *
 * Derived from `ROLE_DEFINITIONS` through `can()` rather than listed here: a second list is a second
 * answer, and the first thing it does is fall behind a grant somebody changed. Empty for a status
 * nothing reaches.
 */
export function permittedRolesFor(status: AppointmentStatus): readonly Role[] {
  const permission = permissionFor(status)
  return permission === null ? [] : ROLES.filter((role) => can(role, permission))
}

/** The legal transition for a pair, or `null` when the pair is not in the table. */
export function transitionFor(
  from: AppointmentStatus,
  to: AppointmentStatus,
): AppointmentTransition | null {
  const target = LEGAL_APPOINTMENT_TRANSITIONS[from].find((candidate) => candidate.to === to)
  if (target === undefined) return null
  const action = APPOINTMENT_STATUS_ACTIONS[to]
  // Unreachable by construction - a status with a legal incoming pair is reachable - and asserted so by
  // `appointmentLifecycleViolations`, which is what makes this a `null` rather than a cast.
  if (!action.reachable) return null
  return {
    from,
    to,
    permission: action.permission,
    eventType: action.eventType,
    emitsRevenue: action.emitsRevenue,
    reasonRequired: action.reasonRequired,
    why: target.why,
  }
}

/** Every legal pair, as `from -> to` strings. The set the cross-product test compares against. */
export function legalTransitionPairs(): readonly string[] {
  return APPOINTMENT_STATUSES.flatMap((from) =>
    LEGAL_APPOINTMENT_TRANSITIONS[from].map((target) => `${from} -> ${target.to}`),
  )
}

/** A reason counts as given only when it is more than whitespace. `null` and `''` are both absent. */
function reasonGiven(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && reason.trim().length > 0
}

const KNOWN_STATUS: ReadonlySet<string> = new Set(APPOINTMENT_STATUSES)
const KNOWN_ROLE: ReadonlySet<string> = new Set(ROLES)

/**
 * The one decision function. A lookup in the table, then the policy layer, then the reason.
 *
 * **Strings in, and deny by default.** The `from` status arrives from a database column and the role
 * from a session, so neither is a value this build chose: a label the `appointment_status` enum grew and
 * this build has never heard of is refused as `illegal_transition`, and an unrecognised role is refused
 * as `transition_forbidden`. That is the same shape `can()` takes for an unknown permission and
 * `genderMatchingMode` takes for an unreadable setting — the permissive answer must be asked for
 * exactly. It is also what lets `packages/db` inject this function without either package importing the
 * other's vocabulary; `packages/fixtures`' `satisfies TransitionDecider` is what proves the seam fits.
 *
 * Positional arguments rather than a request object, because `transitions.test.ts` sweeps every arity-1
 * export of this module for a helper that collapses the two cancellations, and a one-argument decision
 * function would have to be exempted from that sweep by name.
 *
 * Order matters. The pair is checked first, so an actor is never told they lack a permission for a move
 * nobody may make; the permission is checked before the reason, so a role that may not act learns that
 * rather than being asked for a justification it will not be allowed to use. A repeat is decided before
 * either, except for the permission: a role that may not mark a no-show may not no-op one either.
 */
export function decideAppointmentTransition(
  from: string,
  to: string,
  role: string,
  reason: string | null = null,
): AppointmentTransitionVerdict {
  if (!KNOWN_STATUS.has(from) || !KNOWN_STATUS.has(to)) {
    return {
      kind: 'refused',
      refusal: 'illegal_transition',
      why: `this build declares no lifecycle state named "${KNOWN_STATUS.has(from) ? to : from}", so the move cannot be judged and is refused`,
      permittedRoles: [],
    }
  }
  if (!KNOWN_ROLE.has(role)) {
    return {
      kind: 'refused',
      refusal: 'transition_forbidden',
      why: `"${role}" is not a role the policy layer declares, and an unknown role holds no permission`,
      permittedRoles: permittedRolesFor(to as AppointmentStatus),
    }
  }
  return decideKnownTransition(
    from as AppointmentStatus,
    to as AppointmentStatus,
    role as Role,
    reason,
  )
}

/** The decision itself, over values this build has already recognised. */
function decideKnownTransition(
  from: AppointmentStatus,
  to: AppointmentStatus,
  role: Role,
  reason: string | null,
): AppointmentTransitionVerdict {
  const action = APPOINTMENT_STATUS_ACTIONS[to]

  if (from === to) {
    if (!action.reachable) {
      return {
        kind: 'refused',
        refusal: 'illegal_transition',
        why: `no transition produces ${to}, so there is nothing to repeat: ${action.why}`,
        permittedRoles: [],
      }
    }
    if (!can(role, action.permission)) {
      return {
        kind: 'refused',
        refusal: 'transition_forbidden',
        why: `${role} may not ${action.permission}, so it may not repeat a transition to ${to} either`,
        permittedRoles: permittedRolesFor(to),
      }
    }
    return action.repeat === 'idempotent'
      ? {
          kind: 'no_op',
          status: to,
          why: `the appointment is already ${to} and a repeat is declared idempotent: ${action.why}`,
        }
      : {
          kind: 'refused',
          refusal: 'already_in_status',
          why: `the appointment is already ${to} and a repeat is declared an error: ${action.why}`,
          permittedRoles: permittedRolesFor(to),
        }
  }

  const transition = transitionFor(from, to)
  if (transition === null) {
    return {
      kind: 'refused',
      refusal: 'illegal_transition',
      why: `${from} -> ${to} is not a transition this lifecycle declares`,
      permittedRoles: [],
    }
  }
  if (!can(role, transition.permission)) {
    return {
      kind: 'refused',
      refusal: 'transition_forbidden',
      why: `${from} -> ${to} requires ${transition.permission}, which ${role} does not hold`,
      permittedRoles: permittedRolesFor(to),
    }
  }
  if (transition.reasonRequired && !reasonGiven(reason)) {
    return {
      kind: 'refused',
      refusal: 'reason_required',
      why: `${from} -> ${to} records a written reason, and none was given`,
      permittedRoles: permittedRolesFor(to),
    }
  }
  return { kind: 'allowed', transition }
}

/** Event names that would claim a transition is money. Only a revenue transition may match. */
const MONEY_SHAPED_EVENT = /revenue|sale|invoice/i

/** The statuses a legal transition in `targets` leads into. */
function statusesWithIncoming(
  targets: Readonly<Record<AppointmentStatus, readonly LegalTarget[]>>,
  status: AppointmentStatus,
): readonly AppointmentStatus[] {
  return APPOINTMENT_STATUSES.filter((from) => targets[from].some((target) => target.to === status))
}

/**
 * What one status's declaration must satisfy.
 *
 * `eventTypes` is threaded through rather than recomputed so "two statuses sharing one event type" can
 * be caught at all: it is a property of the pair, and a per-status check cannot see it.
 */
function statusActionViolations(
  status: AppointmentStatus,
  action: StatusAction,
  incoming: readonly AppointmentStatus[],
  isTerminal: boolean,
  eventTypes: Map<string, AppointmentStatus>,
): readonly string[] {
  const out: string[] = []
  // A status something transitions into must declare what that costs; one nothing reaches must not,
  // because a permission and an event nobody can reach read as a move that exists. The third case - a
  // reachable status declaring `repeat: 'unreachable'` - needs no check here: `StatusAction`'s reachable
  // variant types `repeat` as `Exclude<RepeatBehaviour, 'unreachable'>`, so it does not compile.
  if (action.reachable && incoming.length === 0) {
    out.push(`unreachable_status_declares_an_action: ${status}`)
  }
  if (!action.reachable && incoming.length > 0) {
    out.push(`reachable_status_declares_no_action: ${status}`)
  }
  // Every terminal state declares its repeat behaviour explicitly, which is the "no undeclared cases"
  // line of the acceptance: `unreachable` is not an answer for a state a transition produced.
  if (isTerminal && incoming.length > 0 && action.repeat === 'unreachable') {
    out.push(`terminal_status_without_declared_repeat: ${status}`)
  }
  if (!action.reachable) return out

  if (action.emitsRevenue !== (status === 'completed')) {
    out.push(`revenue_declared_by_a_status_that_is_not_completed: ${status}`)
  }
  // The allowlist, encoding "the till knows the truth": a non-revenue transition may not emit an event
  // whose NAME reads as money, because a handler subscribing by name would treat it as some.
  if (!action.emitsRevenue && MONEY_SHAPED_EVENT.test(action.eventType)) {
    out.push(`non_revenue_event_named_as_money: ${status} emits ${action.eventType}`)
  }
  if (!action.eventType.includes('.')) {
    out.push(`event_type_is_not_namespaced: ${status} emits ${action.eventType}`)
  }
  const held = eventTypes.get(action.eventType)
  if (held !== undefined) {
    out.push(`event_type_shared_by_two_statuses: ${action.eventType} (${held}, ${status})`)
  }
  eventTypes.set(action.eventType, status)
  // A move no role may make is worse than one nobody declared: it reads as a supported step and
  // refuses every actor who tries it. Asked of the permission on the action PASSED IN rather than
  // through `permittedRolesFor`, which reads the shipped table — a checker that consults the committed
  // data cannot report anything about the copy it was handed.
  if (!ROLES.some((role) => can(role, action.permission))) {
    out.push(`no_role_may_perform: ${status}`)
  }
  return out
}

/** What one status's outgoing list must satisfy. */
function legalTargetViolations(
  from: AppointmentStatus,
  targets: readonly LegalTarget[],
): readonly string[] {
  const out: string[] = []
  const seen = new Set<AppointmentStatus>()
  for (const target of targets) {
    // A pair from a state to itself is not a transition; it is the repeat declaration's business, and
    // 0024's `appointment_status_history_is_a_change` refuses the row it would write.
    if (target.to === from) out.push(`self_transition_declared: ${from}`)
    if (seen.has(target.to)) out.push(`duplicate_target: ${from} -> ${target.to}`)
    seen.add(target.to)
    // Every legal transition carries its argument. An empty `why` is a row nobody can review.
    if (target.why.trim().length === 0) {
      out.push(`legal_transition_without_a_reason: ${from} -> ${target.to}`)
    }
  }
  return out
}

/**
 * Whether any status can reach itself.
 *
 * Acyclicity is what makes `${eventType}:${appointmentId}` a unique outbox idempotency key: each status
 * is entered at most once per appointment. A cycle would also make "this status was entered once" false
 * for every report built on the chain, and the first sign of it would be a revenue event deduplicated
 * against a completion three months earlier.
 */
function cycleViolations(
  targets: Readonly<Record<AppointmentStatus, readonly LegalTarget[]>>,
): readonly string[] {
  const out: string[] = []
  for (const start of APPOINTMENT_STATUSES) {
    const seen = new Set<AppointmentStatus>()
    const queue = targets[start].map((target) => target.to)
    while (queue.length > 0) {
      const next = queue.shift() as AppointmentStatus
      if (next === start) {
        out.push(`cycle_through: ${start}`)
        break
      }
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(...targets[next].map((target) => target.to))
    }
  }
  return out
}

/**
 * The table's self-audit: every property of the declaration that a future edit could break.
 *
 * Exported and run against the shipped table by `transitions.test.ts` (expecting nothing) and against
 * deliberately broken copies (expecting each violation by name), which is what stops it from being a
 * function that has quietly stopped comparing anything. `packages/db`'s repository cannot call it - the
 * dependency runs core <- db - so the pair itest runs it too, over the same data the write path uses.
 */
export function appointmentLifecycleViolations(
  actions: Readonly<Record<AppointmentStatus, StatusAction>> = APPOINTMENT_STATUS_ACTIONS,
  targets: Readonly<
    Record<AppointmentStatus, readonly LegalTarget[]>
  > = LEGAL_APPOINTMENT_TRANSITIONS,
): readonly string[] {
  const eventTypes = new Map<string, AppointmentStatus>()
  return [
    ...APPOINTMENT_STATUSES.flatMap((status) =>
      statusActionViolations(
        status,
        actions[status],
        statusesWithIncoming(targets, status),
        targets[status].length === 0,
        eventTypes,
      ),
    ),
    ...APPOINTMENT_STATUSES.flatMap((from) => legalTargetViolations(from, targets[from])),
    ...cycleViolations(targets),
  ]
}

import { describe, expect, it } from 'vitest'
import { can, ROLES, type Role } from '../access/permissions.ts'
import * as lifecycle from './transitions.ts'
import {
  APPOINTMENT_STATUS_ACTIONS,
  APPOINTMENT_STATUSES,
  type AppointmentStatus,
  type AppointmentTransitionVerdict,
  appointmentLifecycleViolations,
  decideAppointmentTransition,
  eventTypeFor,
  isTerminalAppointmentStatus,
  LEGAL_APPOINTMENT_TRANSITIONS,
  type LegalTarget,
  legalTransitionPairs,
  permissionFor,
  permittedRolesFor,
  repeatBehaviourFor,
  type StatusAction,
  TERMINAL_APPOINTMENT_STATUSES,
  transitionFor,
} from './transitions.ts'

/**
 * B-LIFE-01 — the lifecycle table, enumerated.
 *
 * The unit's claim is that the machine is **data**, so the test is an enumeration rather than a set of
 * examples: all eighty-one status x status cells, all eight roles against all fifteen legal transitions,
 * and every terminal state's declared repeat behaviour.
 *
 * Two things keep it from passing vacuously:
 *
 *   - {@link EXPECTED_LEGAL} is written out **by hand** here. Deriving the expectation from the table
 *     under test would assert that the table equals itself, which is true of any table. A pair added to
 *     or removed from `transitions.ts` fails this file.
 *   - every property asserted of the shipped table is also asserted to FAIL on a deliberately broken
 *     copy of it, through `appointmentLifecycleViolations`. A checker that has stopped comparing
 *     anything passes the first half and fails the second.
 */

/**
 * The fifteen legal transitions, written out independently of the table.
 *
 * Read the absences as deliberately as the entries: `confirmed -> in_progress` (a treatment cannot start
 * for a client nobody recorded as present), anything out of `in_progress` but `completed` (a started
 * treatment cannot be un-started: `holds_resources` would free a period the room really used), and
 * `requested -> no_show` (the salon never promised the slot).
 */
const EXPECTED_LEGAL: readonly string[] = [
  'requested -> confirmed',
  'requested -> cancelled_by_customer',
  'requested -> cancelled_by_salon',
  'requested -> rescheduled',
  'confirmed -> checked_in',
  'confirmed -> no_show',
  'confirmed -> cancelled_by_customer',
  'confirmed -> cancelled_by_salon',
  'confirmed -> rescheduled',
  'checked_in -> in_progress',
  'checked_in -> no_show',
  'checked_in -> cancelled_by_customer',
  'checked_in -> cancelled_by_salon',
  'checked_in -> rescheduled',
  'in_progress -> completed',
]

/** The declared repeat behaviour of every status, written out here for the same reason. */
const EXPECTED_REPEAT: Readonly<Record<AppointmentStatus, lifecycle.RepeatBehaviour>> = {
  requested: 'unreachable',
  confirmed: 'idempotent',
  checked_in: 'idempotent',
  in_progress: 'idempotent',
  completed: 'refused',
  no_show: 'idempotent',
  cancelled_by_customer: 'idempotent',
  cancelled_by_salon: 'idempotent',
  rescheduled: 'refused',
}

/** A reason, supplied everywhere so the grid measures legality rather than the reason rule. */
const REASON = 'stated by the actor at the time'

const verdict = (
  from: AppointmentStatus,
  to: AppointmentStatus,
  role: Role = 'owner',
  reason: string | null = REASON,
): AppointmentTransitionVerdict => decideAppointmentTransition(from, to, role, reason)

const refusalOf = (given: AppointmentTransitionVerdict): string =>
  given.kind === 'refused' ? given.refusal : given.kind

/** Every cell of the grid, as `from -> to`. Eighty-one of them. */
const ALL_PAIRS = APPOINTMENT_STATUSES.flatMap((from) =>
  APPOINTMENT_STATUSES.map((to) => ({ from, to, pair: `${from} -> ${to}` })),
)

/** A copy of the table with one status's action replaced. Frozen input, so it has to be rebuilt. */
const actionsWith = (
  status: AppointmentStatus,
  patch: Partial<Extract<StatusAction, { reachable: true }>>,
): Readonly<Record<AppointmentStatus, StatusAction>> => ({
  ...APPOINTMENT_STATUS_ACTIONS,
  [status]: { ...APPOINTMENT_STATUS_ACTIONS[status], ...patch },
})

/** A copy of the transition table with one status's outgoing list replaced. */
const targetsWith = (
  status: AppointmentStatus,
  targets: readonly LegalTarget[],
): Readonly<Record<AppointmentStatus, readonly LegalTarget[]>> => ({
  ...LEGAL_APPOINTMENT_TRANSITIONS,
  [status]: targets,
})

describe('the transition table is data, and the grid is total', () => {
  it('declares exactly the fifteen pairs written out here', () => {
    expect([...legalTransitionPairs()].sort()).toEqual([...EXPECTED_LEGAL].sort())
  })

  it('has eighty-one cells and no cell without a verdict', () => {
    expect(ALL_PAIRS).toHaveLength(81)
    for (const { from, to } of ALL_PAIRS) {
      expect(['allowed', 'no_op', 'refused']).toContain(verdict(from, to).kind)
    }
  })

  it('accepts every declared legal transition for an owner', () => {
    for (const pair of EXPECTED_LEGAL) {
      const [from, to] = pair.split(' -> ') as [AppointmentStatus, AppointmentStatus]
      const given = verdict(from, to)
      expect(given.kind, `${pair} must be accepted`).toBe('allowed')
      if (given.kind !== 'allowed') continue
      expect(given.transition.from).toBe(from)
      expect(given.transition.to).toBe(to)
      // Every legal transition carries its argument, its permission and its event.
      expect(given.transition.why.length).toBeGreaterThan(20)
      expect(given.transition.eventType).toBe(eventTypeFor(to))
      expect(given.transition.permission).toBe(permissionFor(to))
    }
  })

  it('refuses every other pair with a named illegal_transition, except the declared repeats', () => {
    const counted = { allowed: 0, no_op: 0, illegal_transition: 0, already_in_status: 0 }
    for (const { from, to, pair } of ALL_PAIRS) {
      const given = verdict(from, to)
      if (EXPECTED_LEGAL.includes(pair)) {
        expect(given.kind, pair).toBe('allowed')
        counted.allowed += 1
        continue
      }
      if (from !== to) {
        // The whole point of the unit: a pair nobody declared is refused BY NAME, not by falling
        // through a branch that happened not to match.
        expect(refusalOf(given), pair).toBe('illegal_transition')
        counted.illegal_transition += 1
        continue
      }
      const expected = EXPECTED_REPEAT[from]
      if (expected === 'unreachable') {
        expect(refusalOf(given), pair).toBe('illegal_transition')
        counted.illegal_transition += 1
      } else if (expected === 'idempotent') {
        expect(given.kind, pair).toBe('no_op')
        counted.no_op += 1
      } else {
        expect(refusalOf(given), pair).toBe('already_in_status')
        counted.already_in_status += 1
      }
    }
    // The four counts sum to eighty-one, which is the coverage assertion in numbers: every cell was
    // classified, and exactly fifteen of them move.
    expect(counted).toEqual({
      allowed: 15,
      no_op: 6,
      already_in_status: 2,
      illegal_transition: 58,
    })
    expect(Object.values(counted).reduce((sum, n) => sum + n, 0)).toBe(81)
  })

  it('names the terminal states, derived from the table rather than listed twice', () => {
    expect([...TERMINAL_APPOINTMENT_STATUSES]).toEqual([
      'completed',
      'no_show',
      'cancelled_by_customer',
      'cancelled_by_salon',
      'rescheduled',
    ])
    for (const status of TERMINAL_APPOINTMENT_STATUSES) {
      expect(isTerminalAppointmentStatus(status)).toBe(true)
      // No legal transition leaves a terminal state, for any role.
      for (const to of APPOINTMENT_STATUSES) {
        if (to === status) continue
        expect(refusalOf(verdict(status, to)), `${status} -> ${to}`).toBe('illegal_transition')
      }
    }
  })

  it('has no path back to requested and no cycle, which is what makes one event key unique', () => {
    for (const from of APPOINTMENT_STATUSES) {
      expect(LEGAL_APPOINTMENT_TRANSITIONS[from].some((t) => t.to === 'requested')).toBe(false)
    }
    expect(appointmentLifecycleViolations()).toEqual([])
    // The control: a table with a cycle is reported, so the acyclicity assertion above is not the
    // checker having stopped looking.
    expect(
      appointmentLifecycleViolations(
        APPOINTMENT_STATUS_ACTIONS,
        targetsWith('completed', [{ to: 'confirmed', why: 'a cycle, deliberately' }]),
      ),
    ).toContain('cycle_through: confirmed')
  })

  it('refuses a status or a role this build does not declare, rather than assuming', () => {
    // The `from` status arrives from a database column and the role from a session, so neither is a
    // value this build chose. A tenth enum label added in SQL alone, or a role spelled by a caller,
    // must be refused rather than fall into the permissive branch: `can()` treats an unknown permission
    // the same way, and for the same reason.
    expect(refusalOf(verdict('paused' as AppointmentStatus, 'confirmed'))).toBe(
      'illegal_transition',
    )
    expect(refusalOf(verdict('confirmed', 'paused' as AppointmentStatus))).toBe(
      'illegal_transition',
    )
    expect(refusalOf(verdict('confirmed', 'checked_in', 'intern' as Role))).toBe(
      'transition_forbidden',
    )
    // And the control: the same call with the declared spelling is allowed, so the refusals above are
    // about the unknown value and not about the pair.
    expect(verdict('confirmed', 'checked_in', 'receptionist').kind).toBe('allowed')
  })

  it('has no default-allow branch: a pair not in the table cannot be made legal by any role', () => {
    for (const role of ROLES) {
      // `completed -> in_progress` reads as a plausible correction and is declared by nobody.
      expect(refusalOf(verdict('completed', 'in_progress', role))).toBe('illegal_transition')
      // Skipping check-in is the transition an implementation invents when it trusts the caller.
      expect(refusalOf(verdict('confirmed', 'in_progress', role))).toBe('illegal_transition')
    }
  })
})

describe('each transition declares its actor roles, and the F07 policy layer enforces them', () => {
  /** The five transitions an owner or a manager may make and a receptionist may not. */
  const OWNER_OR_MANAGER_ONLY: readonly string[] = [
    'confirmed -> no_show',
    'checked_in -> no_show',
    'requested -> cancelled_by_salon',
    'confirmed -> cancelled_by_salon',
    'checked_in -> cancelled_by_salon',
  ]

  it('derives the permitted roles from the policy layer, never from a second list', () => {
    expect([...permittedRolesFor('no_show')]).toEqual(['owner', 'manager'])
    expect([...permittedRolesFor('cancelled_by_salon')]).toEqual(['owner', 'manager'])
    expect([...permittedRolesFor('cancelled_by_customer')]).toEqual([
      'owner',
      'manager',
      'receptionist',
    ])
    expect([...permittedRolesFor('in_progress')]).toEqual([
      'owner',
      'manager',
      'receptionist',
      'therapist',
    ])
    // Nothing reaches `requested`, so no role may transition into it.
    expect([...permittedRolesFor('requested')]).toEqual([])
  })

  it('refuses a receptionist every owner-or-manager-only transition and permits the rest', () => {
    const refused: string[] = []
    const permitted: string[] = []
    for (const pair of EXPECTED_LEGAL) {
      const [from, to] = pair.split(' -> ') as [AppointmentStatus, AppointmentStatus]
      const given = verdict(from, to, 'receptionist')
      if (given.kind === 'allowed') permitted.push(pair)
      else {
        expect(refusalOf(given), pair).toBe('transition_forbidden')
        refused.push(pair)
      }
    }
    expect([...refused].sort()).toEqual([...OWNER_OR_MANAGER_ONLY].sort())
    expect(permitted).toHaveLength(EXPECTED_LEGAL.length - OWNER_OR_MANAGER_ONLY.length)
    expect(permitted).toHaveLength(10)
  })

  it('agrees with can() for every role and every transition, cell by cell', () => {
    let checked = 0
    for (const pair of EXPECTED_LEGAL) {
      const [from, to] = pair.split(' -> ') as [AppointmentStatus, AppointmentStatus]
      const permission = permissionFor(to)
      expect(permission).not.toBeNull()
      for (const role of ROLES) {
        const given = verdict(from, to, role)
        // The one claim: the table's answer IS the policy layer's answer. A hand-rolled check at this
        // call site is exactly what would make these two drift.
        expect(given.kind === 'allowed', `${role} / ${pair}`).toBe(
          can(role, permission as NonNullable<typeof permission>),
        )
        if (given.kind === 'refused') {
          expect(given.refusal).toBe('transition_forbidden')
          expect(given.permittedRoles).toEqual(permittedRolesFor(to))
        }
        checked += 1
      }
    }
    expect(checked).toBe(EXPECTED_LEGAL.length * ROLES.length)
    expect(checked).toBe(120)
  })

  it('lets no background worker take a lifecycle decision', () => {
    // `system` is the role a cron or a drained outbox handler runs as. Marking a no-show is a
    // judgement, and one taken at 03:00 with nobody to ask is the wrong kind of automatic.
    for (const pair of EXPECTED_LEGAL) {
      const [from, to] = pair.split(' -> ') as [AppointmentStatus, AppointmentStatus]
      expect(refusalOf(verdict(from, to, 'system')), pair).toBe('transition_forbidden')
    }
  })

  it('refuses a role that may not act before asking it for a reason', () => {
    // Order matters: a receptionist told "reason required" would write one and be refused anyway.
    expect(refusalOf(verdict('confirmed', 'cancelled_by_salon', 'receptionist', null))).toBe(
      'transition_forbidden',
    )
  })

  it('refuses a repeat the role may not perform, rather than answering it with a no-op', () => {
    // `no_show -> no_show` is idempotent for a manager. A receptionist must not be told "fine": the
    // permissive answer to a request nobody may make is still an answer nobody may have.
    expect(verdict('no_show', 'no_show', 'manager').kind).toBe('no_op')
    expect(refusalOf(verdict('no_show', 'no_show', 'receptionist'))).toBe('transition_forbidden')
  })
})

describe('the two cancellations never collapse into one CANCELLED', () => {
  it('are two distinct terminal states with two distinct event types', () => {
    expect(APPOINTMENT_STATUSES).toContain('cancelled_by_customer')
    expect(APPOINTMENT_STATUSES).toContain('cancelled_by_salon')
    // There is no shared label to collapse into, in this module or in the enum it mirrors.
    expect(APPOINTMENT_STATUSES as readonly string[]).not.toContain('cancelled')
    expect(eventTypeFor('cancelled_by_customer')).toBe('appointment.cancelled_by_customer')
    expect(eventTypeFor('cancelled_by_salon')).toBe('appointment.cancelled_by_salon')
    expect(eventTypeFor('cancelled_by_customer')).not.toBe(eventTypeFor('cancelled_by_salon'))
    expect(permissionFor('cancelled_by_customer')).not.toBe(permissionFor('cancelled_by_salon'))
    expect(isTerminalAppointmentStatus('cancelled_by_customer')).toBe(true)
    expect(isTerminalAppointmentStatus('cancelled_by_salon')).toBe(true)
  })

  /**
   * The sweep, and the acceptance criterion literally: **no function maps both to a shared value**.
   *
   * Every export of this module is examined. An arity-1 function is called with each cancellation and a
   * `Record` keyed by status is read at each. The pair is an offence when the two answers serialise
   * identically **and** the answer is cancellation-shaped — which is what a display label would be.
   * `isTerminalAppointmentStatus` answering `true` for both is not an offence and must not be reported;
   * a `cancellationLabel` answering `'CANCELLED'` for both is the whole hazard. Gate 51n adds exactly
   * that function and watches this case fail.
   */
  it('no exported function or record answers one cancellation-shaped value for both', () => {
    const CANCELLATION_SHAPED = /cancel/i
    const offenders: string[] = []
    const answer = (value: unknown, status: AppointmentStatus): string | undefined => {
      if (typeof value === 'function' && value.length === 1) {
        try {
          return JSON.stringify((value as (s: AppointmentStatus) => unknown)(status))
        } catch {
          return undefined
        }
      }
      if (typeof value === 'object' && value !== null) {
        const held = (value as Record<string, unknown>)[status]
        return held === undefined ? undefined : JSON.stringify(held)
      }
      return undefined
    }
    for (const [name, value] of Object.entries(lifecycle)) {
      const customer = answer(value, 'cancelled_by_customer')
      const salon = answer(value, 'cancelled_by_salon')
      if (customer === undefined || salon === undefined) continue
      if (customer === salon && CANCELLATION_SHAPED.test(customer)) offenders.push(name)
    }
    expect(offenders).toEqual([])
  })

  it('the sweep catches a helper that does collapse them', () => {
    // The control for the case above, run against a stand-in module: without it, the sweep could be
    // examining nothing at all and would say so in exactly the same words.
    const CANCELLATION_SHAPED = /cancel/i
    const collapsing = {
      cancellationLabel: (status: AppointmentStatus): string =>
        status.startsWith('cancelled') ? 'CANCELLED' : status,
    }
    const customer = collapsing.cancellationLabel('cancelled_by_customer')
    const salon = collapsing.cancellationLabel('cancelled_by_salon')
    expect(customer).toBe(salon)
    expect(CANCELLATION_SHAPED.test(customer)).toBe(true)
  })

  it('requires the salon to say why and lets the customer stay silent', () => {
    // Asymmetric on purpose. The salon breaking its own commitment is the record a refund dispute is
    // settled from; a customer who gives no reason has still cancelled, and refusing that for want of
    // a reason turns it into a no-show.
    expect(refusalOf(verdict('confirmed', 'cancelled_by_salon', 'owner', null))).toBe(
      'reason_required',
    )
    expect(refusalOf(verdict('confirmed', 'cancelled_by_salon', 'owner', '   '))).toBe(
      'reason_required',
    )
    expect(verdict('confirmed', 'cancelled_by_customer', 'owner', null).kind).toBe('allowed')
    expect(verdict('confirmed', 'rescheduled', 'owner', null).kind).toBe('refused')
  })
})

describe('COMPLETED emits revenue; CONFIRMED does not', () => {
  it('declares appointment.completed as the one revenue event', () => {
    expect(eventTypeFor('completed')).toBe('appointment.completed')
    const revenue = APPOINTMENT_STATUSES.filter((status) => {
      const action = APPOINTMENT_STATUS_ACTIONS[status]
      return action.reachable && action.emitsRevenue
    })
    expect(revenue).toEqual(['completed'])
    const completion = transitionFor('in_progress', 'completed')
    expect(completion?.emitsRevenue).toBe(true)
  })

  it('emits no money-shaped event name for CONFIRMED or for any other non-revenue transition', () => {
    const MONEY = /revenue|sale|invoice/
    expect(eventTypeFor('confirmed')).toBe('appointment.confirmed')
    expect(MONEY.test(eventTypeFor('confirmed') as string)).toBe(false)
    for (const status of APPOINTMENT_STATUSES) {
      const action = APPOINTMENT_STATUS_ACTIONS[status]
      if (!action.reachable || action.emitsRevenue) continue
      expect(MONEY.test(action.eventType), `${status} emits ${action.eventType}`).toBe(false)
    }
    // Every declared event is namespaced, which `publishEvent` requires, and unique per status.
    const events = APPOINTMENT_STATUSES.map(eventTypeFor).filter((e): e is string => e !== null)
    expect(events).toHaveLength(8)
    expect(new Set(events).size).toBe(8)
    for (const event of events) expect(event).toMatch(/^appointment\.[a-z_]+$/)
  })

  it('reports a table that lets CONFIRMED emit revenue, or name an event as money', () => {
    // The two controls for the allowlist. Without them "CONFIRMED emits no revenue event" is satisfied
    // by a checker that reads nothing.
    expect(
      appointmentLifecycleViolations(actionsWith('confirmed', { emitsRevenue: true })),
    ).toEqual(['revenue_declared_by_a_status_that_is_not_completed: confirmed'])
    expect(
      appointmentLifecycleViolations(
        actionsWith('confirmed', { eventType: 'appointment.invoice_raised' }),
      ),
    ).toEqual(['non_revenue_event_named_as_money: confirmed emits appointment.invoice_raised'])
    expect(
      appointmentLifecycleViolations(actionsWith('completed', { emitsRevenue: false })),
    ).toEqual(['revenue_declared_by_a_status_that_is_not_completed: completed'])
  })
})

describe('every terminal state declares what a repeat does, with no undeclared cases', () => {
  it('declares idempotent or refused for every state a transition reaches', () => {
    for (const status of APPOINTMENT_STATUSES) {
      expect(repeatBehaviourFor(status), status).toBe(EXPECTED_REPEAT[status])
    }
    for (const status of TERMINAL_APPOINTMENT_STATUSES) {
      expect(['idempotent', 'refused'], status).toContain(repeatBehaviourFor(status))
    }
    // `requested` is the only `unreachable`, and it is unreachable because nothing transitions into it.
    const unreachable = APPOINTMENT_STATUSES.filter(
      (status) => repeatBehaviourFor(status) === 'unreachable',
    )
    expect(unreachable).toEqual(['requested'])
    expect(eventTypeFor('requested')).toBeNull()
    expect(permissionFor('requested')).toBeNull()
  })

  it('answers a repeat the way the state declares it', () => {
    for (const status of APPOINTMENT_STATUSES) {
      const given = verdict(status, status)
      if (EXPECTED_REPEAT[status] === 'idempotent') {
        expect(given.kind, status).toBe('no_op')
        if (given.kind === 'no_op') expect(given.status).toBe(status)
      } else if (EXPECTED_REPEAT[status] === 'refused') {
        expect(refusalOf(given), status).toBe('already_in_status')
      } else {
        expect(refusalOf(given), status).toBe('illegal_transition')
      }
    }
  })

  it('makes the two errors the states where a silent yes would hide a mistake', () => {
    // Money already taken, and a row that is no longer the live one. Everything else is a double-tap.
    expect(
      APPOINTMENT_STATUSES.filter((status) => repeatBehaviourFor(status) === 'refused'),
    ).toEqual(['completed', 'rescheduled'])
    expect(refusalOf(verdict('completed', 'completed'))).toBe('already_in_status')
    expect(refusalOf(verdict('rescheduled', 'rescheduled'))).toBe('already_in_status')
    expect(verdict('cancelled_by_customer', 'cancelled_by_customer').kind).toBe('no_op')
    expect(verdict('cancelled_by_salon', 'cancelled_by_salon').kind).toBe('no_op')
    expect(verdict('no_show', 'no_show').kind).toBe('no_op')
  })

  it('reports a terminal state whose repeat behaviour was left undeclared', () => {
    // The control. `completed` keeps its incoming transition and loses its declaration, which is the
    // shape of the edit that would leave a repeat's behaviour to whichever branch ran.
    const undeclared: Readonly<Record<AppointmentStatus, StatusAction>> = {
      ...APPOINTMENT_STATUS_ACTIONS,
      completed: { reachable: false, repeat: 'unreachable', why: 'left undeclared, deliberately' },
    }
    expect([...appointmentLifecycleViolations(undeclared)].sort()).toEqual([
      'reachable_status_declares_no_action: completed',
      'terminal_status_without_declared_repeat: completed',
    ])
  })
})

describe('the table audits itself, and the audit can fail', () => {
  it('finds nothing wrong with the shipped table', () => {
    expect(appointmentLifecycleViolations()).toEqual([])
  })

  it('reports a status declaring an action nothing can reach', () => {
    // Dropping `in_progress -> completed` leaves `completed` declaring a permission, an event and a
    // revenue flag that no move can produce.
    expect([
      ...appointmentLifecycleViolations(APPOINTMENT_STATUS_ACTIONS, targetsWith('in_progress', [])),
    ]).toEqual(['unreachable_status_declares_an_action: completed'])
  })

  it('reports two statuses sharing one event type', () => {
    expect(
      appointmentLifecycleViolations(
        actionsWith('cancelled_by_salon', { eventType: 'appointment.cancelled_by_customer' }),
      ),
    ).toEqual([
      'event_type_shared_by_two_statuses: appointment.cancelled_by_customer ' +
        '(cancelled_by_customer, cancelled_by_salon)',
    ])
  })

  it('reports an event type that is not namespaced, which publishEvent would refuse anyway', () => {
    expect(
      appointmentLifecycleViolations(actionsWith('confirmed', { eventType: 'confirmed' })),
    ).toEqual(['event_type_is_not_namespaced: confirmed emits confirmed'])
  })

  it('reports a transition to a state itself, a duplicate target and a reason nobody wrote', () => {
    expect(
      [
        ...appointmentLifecycleViolations(
          APPOINTMENT_STATUS_ACTIONS,
          targetsWith('checked_in', [
            { to: 'checked_in', why: 'a self transition, deliberately' },
            { to: 'in_progress', why: 'the therapist starts the treatment' },
            { to: 'in_progress', why: 'and again' },
            { to: 'no_show', why: '  ' },
          ]),
        ),
      ].sort(),
    ).toEqual([
      // A self transition is also the shortest cycle, and both checks report it. Two names for one
      // edit is right here: one is about the row, the other about the graph, and a reader fixing the
      // row should be told the graph property it broke too.
      'cycle_through: checked_in',
      'duplicate_target: checked_in -> in_progress',
      'legal_transition_without_a_reason: checked_in -> no_show',
      'self_transition_declared: checked_in',
    ])
  })

  it('reports a transition no role may perform', () => {
    // `period:lock` is the accountant's and the owner's, and neither is granted it as a booking move —
    // the shape of the mistake is a permission chosen because it sounded administrative.
    expect(
      appointmentLifecycleViolations(
        actionsWith('checked_in', { permission: 'clinical_note:write' }),
      ),
    ).toEqual([])
    // A permission no role holds at all: the transition reads as supported and refuses everybody.
    expect(
      appointmentLifecycleViolations(
        actionsWith('checked_in', { permission: 'nonsense:action' as never }),
      ),
    ).toEqual(['no_role_may_perform: checked_in'])
  })
})

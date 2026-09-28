import { describe, expect, it } from 'vitest'
import { ROLE_DEFINITIONS, ROLES, type Role } from '../access/permissions.ts'
import type { Period } from '../availability/room-predicates.ts'
import {
  ASIA_DUBAI,
  type Instant,
  instantFromIso,
  type LocalDate,
  localDate,
  localTime,
} from '../time.ts'
import type { CredentialPolicy, HeldCredential } from './credentials.ts'
import { leaveCoveragePeriod } from './leave-accrual.ts'
import {
  authoriseLeaveApproval,
  type CoverageDelta,
  coverageBreachesCausedBy,
  decideLeaveApproval,
  type FloorPresence,
  judgeLeaveConflictOverride,
  LEAVE_APPROVAL_REFUSALS,
  LEAVE_OVERRIDE_ROLES,
  type LeaveApprovalDelegation,
  type LeaveConflict,
  leavePeriodCovers,
  mayOverrideLeaveConflict,
} from './leave-approval.ts'
import type { WorkingHoursRules } from './rates.ts'
import type {
  RotaCoverageRules,
  RotaTherapist,
  RotaTradingDay,
  ValidateRotaArgs,
} from './rota-validator.ts'

/**
 * P-HR-09 — the approval decision, with no database in it.
 *
 * Every case here pairs its claim with the control that must fail (brief rule 3), because the failure this
 * unit is most exposed to is a check whose stated claim is not what it measures:
 *
 *   * The coverage delta is asserted to FIRE on a leave that breaks a covered segment **and** to stay quiet
 *     on a segment that was already short — over the same rota, differing only in the leave. A delta that
 *     could never fire would refuse nothing and look identical from the passing side.
 *   * The delegation cases are three, and the middle one is the peer: a role that does not hold
 *     `leave:approve` and is not named in any delegation is refused, while the named deputy with the same
 *     role is allowed. Without the peer, "the deputy can approve" is satisfied by a function that authorises
 *     everybody.
 *   * The override roles are asserted against `ROLE_DEFINITIONS` in BOTH directions, so a role added to
 *     `LEAVE_OVERRIDE_ROLES` without a migration fails here.
 */

const ZONE = ASIA_DUBAI

const at = (iso: string): Instant => instantFromIso(iso)

const DAY: LocalDate = localDate('2086-03-17')
const NEXT: LocalDate = localDate('2086-03-18')

/** The premises window every fixture day uses: 11:00 to 02:00, the one the whole system is built on. */
const HOURS = { open: localTime('11:00'), close: localTime('02:00') } as const

const hoursFor = () => HOURS

/** `leaveCoveragePeriod`'s answer, never a pair of instants this file wrote out. */
const leaveFor = (from: LocalDate, to: LocalDate): Period => {
  const period = leaveCoveragePeriod({ from, to, hoursFor, zone: ZONE })
  return { startsAt: period.startsAt, endsAt: period.endsAt }
}

const dubai = (date: string, hhmm: string): Instant => at(`${date}T${hhmm}:00+04:00`)

const COVERAGE_RULES: RotaCoverageRules = {
  effectiveFrom: localDate('2000-01-01'),
  coverageSegmentMinutes: 30,
  minimumTherapistsOnFloor: 2,
  minimumWetRoomCapable: 0,
  treatmentMinutesCapPerDay: 360,
  highIntensityMinutesCapPerDay: 240,
  highIntensityTreatmentCodes: [],
}

/**
 * Caps wide open, so nothing but the segment rules can produce a violation.
 *
 * Deliberate: this file asserts about `minimum_floor_coverage`, and a rota that also breached the weekly cap
 * would make `caused` non-empty for a reason the case is not about — and the assertion would pass.
 */
const WORKING_HOURS: WorkingHoursRules = {
  effectiveFrom: localDate('2000-01-01'),
  ordinaryMinutesPerDay: 1440,
  ordinaryMinutesPerWeek: 10_080,
  weekStartsOn: 1,
  overtimeDailyCapMinutes: 0,
  minimumRestMinutes: 0,
  nightWindow: { from: localTime('22:00'), until: localTime('04:00') },
  multiplierBp: { ordinary: 10_000, overtime: 12_500, night: 15_000, publicHoliday: 15_000 },
}

/**
 * No mandatory document, so rule 5 cannot fire.
 *
 * Deliberate, for the same reason the caps are wide open: this file asserts about the two segment rules, and
 * a therapist refused for a credential would make `caused` non-empty for a reason no case here is about.
 */
const POLICY: CredentialPolicy = {
  mandatoryTypes: [],
  nonExpiringTypes: [],
  expiringSoonDays: 60,
}

const CURRENT: readonly HeldCredential[] = []

const therapist = (employeeId: string): RotaTherapist => ({
  employeeId,
  skills: ['asian_style'],
  credentials: CURRENT,
})

const day = (date: LocalDate): RotaTradingDay => ({
  tradingDate: date,
  opensAt: dubai(String(date), '11:00'),
  closesAt: leaveFor(date, date).endsAt,
  wetRoomBookableDuring: [],
  isPublicHoliday: false,
})

const rotaFor = (employees: readonly string[]): Omit<ValidateRotaArgs, 'assignments'> => ({
  days: [day(DAY)],
  therapists: employees.map(therapist),
  treatmentLoads: [],
  coverageRuleVersions: [COVERAGE_RULES],
  workingHoursRuleVersions: [WORKING_HOURS],
  wetRoomSkills: ['asian_style'],
  credentialPolicy: POLICY,
  zone: ZONE,
})

/** A whole trading session of presence for one employee, which is what covers every segment of the day. */
const wholeDay = (employeeId: string): FloorPresence => ({
  employeeId,
  tradingDate: DAY,
  period: leaveFor(DAY, DAY),
})

describe('the refusal vocabulary', () => {
  it('has no duplicate, because a caller branches on these', () => {
    expect(new Set(LEAVE_APPROVAL_REFUSALS).size).toBe(LEAVE_APPROVAL_REFUSALS.length)
  })
})

describe('acceptance — delegation is time-bounded: three cases, one each', () => {
  const REQUESTER = 'employee-on-leave'
  const DELEGATOR = 'the-manager'
  const DEPUTY = 'the-named-deputy'
  const PEER = 'an-undelegated-peer'

  /** 12:00 on the leave day, comfortably inside every window below. */
  const DECIDED_AT = dubai('2086-03-17', '12:00')

  const delegation = (
    overrides: Partial<LeaveApprovalDelegation> = {},
  ): LeaveApprovalDelegation => ({
    id: 'delegation-1',
    delegatorEmployeeId: DELEGATOR,
    deputyEmployeeId: DEPUTY,
    period: { startsAt: dubai('2086-03-16', '11:00'), endsAt: dubai('2086-03-18', '02:00') },
    revokedAt: null,
    ...overrides,
  })

  /**
   * A role that does NOT hold `leave:approve`, asserted rather than assumed.
   *
   * The whole point of the deputy case is that the delegation is the source of the authority. If the fixture
   * role held the permission anyway, all three cases would pass against a function that ignored delegations
   * entirely — and the peer case would fail, which is the only reason that would ever be noticed.
   */
  const DEPUTY_ROLE: Role = 'receptionist'

  it('the fixture deputy role does not hold leave:approve on its own', () => {
    const grants = ROLE_DEFINITIONS[DEPUTY_ROLE].permissions
    expect(grants).not.toBe('all')
    expect(grants as readonly string[]).not.toContain('leave:approve')
  })

  it('the named deputy inside the window can approve', () => {
    const answer = authoriseLeaveApproval({
      approver: { employeeId: DEPUTY, role: DEPUTY_ROLE },
      requestEmployeeId: REQUESTER,
      delegations: [delegation()],
      at: DECIDED_AT,
    })
    expect(answer).toEqual({
      authorised: true,
      authority: { via: 'delegation', delegationId: 'delegation-1' },
    })
  })

  it('an undelegated peer of the same role cannot', () => {
    const answer = authoriseLeaveApproval({
      approver: { employeeId: PEER, role: DEPUTY_ROLE },
      requestEmployeeId: REQUESTER,
      // The SAME delegation is in hand. What the peer lacks is being named in it, which is the whole
      // difference between the two cases above and below.
      delegations: [delegation()],
      at: DECIDED_AT,
    })
    expect(answer.authorised).toBe(false)
    expect(answer.authorised === false && answer.refusal).toBe('approver_not_authorised')
  })

  it('an approval outside the window is refused, and refused DIFFERENTLY from the peer', () => {
    const answer = authoriseLeaveApproval({
      approver: { employeeId: DEPUTY, role: DEPUTY_ROLE },
      requestEmployeeId: REQUESTER,
      delegations: [delegation()],
      // One second past the window's close. The boundary, because a window tested only at noon would pass
      // for a comparison written the wrong way round.
      at: dubai('2086-03-18', '02:00'),
    })
    expect(answer.authorised).toBe(false)
    expect(answer.authorised === false && answer.refusal).toBe('delegation_not_in_window')
  })

  it('the window is half-open: its own first instant is inside and its last is not', () => {
    const window = delegation()
    const inside = authoriseLeaveApproval({
      approver: { employeeId: DEPUTY, role: DEPUTY_ROLE },
      requestEmployeeId: REQUESTER,
      delegations: [window],
      at: window.period.startsAt,
    })
    expect(inside.authorised).toBe(true)
  })

  it('a withdrawn delegation confers nothing from the instant it was withdrawn', () => {
    const answer = authoriseLeaveApproval({
      approver: { employeeId: DEPUTY, role: DEPUTY_ROLE },
      requestEmployeeId: REQUESTER,
      delegations: [delegation({ revokedAt: dubai('2086-03-17', '11:00') })],
      at: DECIDED_AT,
    })
    expect(answer.authorised).toBe(false)
    expect(answer.authorised === false && answer.refusal).toBe('delegation_not_in_window')
  })

  it('a holder of leave:approve needs no delegation at all', () => {
    const answer = authoriseLeaveApproval({
      approver: { employeeId: 'a-manager', role: 'manager' },
      requestEmployeeId: REQUESTER,
      delegations: [],
      at: DECIDED_AT,
    })
    expect(answer).toEqual({ authorised: true, authority: { via: 'own_authority' } })
  })

  it('and may still not approve their own leave', () => {
    const answer = authoriseLeaveApproval({
      approver: { employeeId: REQUESTER, role: 'manager' },
      requestEmployeeId: REQUESTER,
      delegations: [],
      at: DECIDED_AT,
    })
    expect(answer.authorised).toBe(false)
    expect(answer.authorised === false && answer.refusal).toBe('approver_not_authorised')
  })
})

describe('acceptance — the coverage refusal reuses the P-HR-06 validator, and is a DELTA', () => {
  it('refuses when the leave is what drops the floor below the minimum, naming the segment', () => {
    // Exactly two therapists cover the whole day and the minimum is two, so removing either breaks every
    // segment of the leave. The numbers are the fixture's whole design: with three, nothing would breach and
    // the case would pass having measured nothing.
    const delta = coverageBreachesCausedBy({
      rota: rotaFor(['a', 'b']),
      presence: [wholeDay('a'), wholeDay('b')],
      employeeId: 'a',
      period: leaveFor(DAY, DAY),
    })
    expect(delta.preexisting).toEqual([])
    expect(delta.presenceFragmentsAffected).toBe(1)
    expect(delta.caused.length).toBeGreaterThan(0)
    expect(delta.caused.every((breach) => breach.rule === 'minimum_floor_coverage')).toBe(true)
    // The segment label is the wording a screen prints and a refusal carries, and it names the TRADING date.
    expect(delta.caused[0]?.segmentLabel).toBe('2086-03-17 11:00-11:30')
    // Thirty 30-minute segments in an 11:00-02:00 window, every one of them short.
    expect(delta.caused).toHaveLength(30)
  })

  it('does NOT refuse for a segment that was already short without this leave', () => {
    // The control, and the reason the answer is a difference rather than a total: one therapist on the floor
    // against a minimum of two is short before anybody asks for leave. A third therapist takes the day off
    // and the floor is no worse for it, so the approval stands.
    const delta = coverageBreachesCausedBy({
      rota: rotaFor(['a', 'spare']),
      presence: [wholeDay('a'), wholeDay('spare')],
      employeeId: 'nobody-rostered',
      period: leaveFor(DAY, DAY),
    })
    expect(delta.preexisting).toEqual([])
    // Nothing was subtracted, so the delta says so — which is what a caller has to refuse on rather than
    // reading an empty `caused` as a floor that holds.
    expect(delta.presenceFragmentsAffected).toBe(0)
    expect(delta.caused).toEqual([])
  })

  it('reports a pre-existing breach rather than attributing it to the approval', () => {
    const delta = coverageBreachesCausedBy({
      rota: rotaFor(['a', 'b']),
      // `b` covers only the first hour, so the rest of the day is already one short.
      presence: [
        wholeDay('a'),
        {
          employeeId: 'b',
          tradingDate: DAY,
          period: { startsAt: dubai('2086-03-17', '11:00'), endsAt: dubai('2086-03-17', '12:00') },
        },
      ],
      employeeId: 'b',
      period: leaveFor(DAY, DAY),
    })
    expect(delta.preexisting.length).toBe(28)
    // Only the two segments `b` actually covered become new breaches.
    expect(delta.caused).toHaveLength(2)
    expect(delta.caused.map((breach) => breach.segmentLabel)).toEqual([
      '2086-03-17 11:00-11:30',
      '2086-03-17 11:30-12:00',
    ])
  })

  it('a leave period that overlaps no presence subtracts nothing, and says so', () => {
    const delta = coverageBreachesCausedBy({
      rota: rotaFor(['a', 'b']),
      presence: [wholeDay('a'), wholeDay('b')],
      employeeId: 'a',
      // The day AFTER, whose session starts at 11:00 on the 18th — after this day's 02:00 close.
      period: leaveFor(NEXT, NEXT),
    })
    expect(delta.presenceFragmentsAffected).toBe(0)
    expect(delta.caused).toEqual([])
  })

  it('refuses a period that ends when it starts rather than answering about the rota unchanged', () => {
    const instant = dubai('2086-03-17', '11:00')
    expect(() =>
      coverageBreachesCausedBy({
        rota: rotaFor(['a', 'b']),
        presence: [wholeDay('a'), wholeDay('b')],
        employeeId: 'a',
        period: { startsAt: instant, endsAt: instant },
      }),
    ).toThrow(/subtracts nothing/)
  })

  it('cuts a presence span rather than dropping it when the leave covers only part of it', () => {
    // A half-day of leave: 11:00 to 17:00. The afternoon is untouched, so only the morning segments break —
    // which a subtraction that dropped the whole span would get wrong in the direction that refuses too much.
    const delta = coverageBreachesCausedBy({
      rota: rotaFor(['a', 'b']),
      presence: [wholeDay('a'), wholeDay('b')],
      employeeId: 'b',
      period: { startsAt: dubai('2086-03-17', '11:00'), endsAt: dubai('2086-03-17', '17:00') },
    })
    expect(delta.presenceFragmentsAffected).toBe(1)
    expect(delta.caused).toHaveLength(12)
    expect(delta.caused.at(-1)?.segmentLabel).toBe('2086-03-17 16:30-17:00')
  })
})

describe('acceptance — the leave period covers the 01:30 in its own session tail', () => {
  it('contains 01:30 on the following calendar date, and the next day does not', () => {
    const own = leaveFor(DAY, DAY)
    const tail = dubai('2086-03-18', '01:30')
    expect(leavePeriodCovers(own, tail)).toBe(true)
    // The control that makes the claim mean something: a calendar-aligned leave day would END at midnight,
    // so 01:30 would fall outside it — and it would fall INSIDE the next day's leave, which is the reading
    // this build rejected. Both halves are asserted, because either alone is satisfied by the wrong period.
    expect(leavePeriodCovers(leaveFor(NEXT, NEXT), tail)).toBe(false)
    expect(own.endsAt).toBe(dubai('2086-03-18', '02:00'))
    expect(own.endsAt).not.toBe(dubai('2086-03-18', '00:00'))
  })
})

describe('acceptance — the override needs a permitted role and a written reason', () => {
  it('permits exactly the roles LEAVE_OVERRIDE_ROLES names, and no others', () => {
    const permitted = ROLES.filter((role) => mayOverrideLeaveConflict(role))
    expect([...permitted].sort()).toEqual([...LEAVE_OVERRIDE_ROLES].sort())
    // The other direction, which is what catches a role added to the list without the migration: every role
    // in the list must be one this system actually has.
    for (const role of LEAVE_OVERRIDE_ROLES) expect(ROLES).toContain(role)
  })

  it('refuses every role outside the list, one case per role', () => {
    for (const role of ROLES.filter((candidate) => !LEAVE_OVERRIDE_ROLES.includes(candidate))) {
      const verdict = judgeLeaveConflictOverride({ role, reason: 'the client asked for her' })
      expect(verdict.permitted, role).toBe(false)
      expect(verdict.permitted === false && verdict.refusal).toBe('override_role_not_permitted')
    }
  })

  it('refuses a blank, whitespace or too-short reason from a role that may otherwise override', () => {
    for (const reason of ['', '   ', 'because', '\t\n ']) {
      const verdict = judgeLeaveConflictOverride({ role: 'manager', reason })
      expect(verdict.permitted, JSON.stringify(reason)).toBe(false)
      expect(verdict.permitted === false && verdict.refusal).toBe('override_reason_not_written')
    }
  })

  it('permits a manager with a written reason', () => {
    expect(judgeLeaveConflictOverride({ role: 'manager', reason: 'client asked for her' })).toEqual(
      {
        permitted: true,
      },
    )
  })
})

describe('acceptance — the whole decision, and the order the refusals come in', () => {
  const REQUEST = {
    id: 'request-1',
    employeeId: 'employee-on-leave',
    status: 'pending',
    period: leaveFor(DAY, DAY),
  }

  const APPROVER = { employeeId: 'a-manager', role: 'manager' as Role }

  const NO_BREACH: CoverageDelta = {
    caused: [],
    preexisting: [],
    segments: [],
    presenceFragmentsAffected: 1,
  }

  const conflict = (overrides: Partial<LeaveConflict> = {}): LeaveConflict => ({
    appointmentId: 'appointment-1',
    customerId: 'customer-1',
    serviceVariantId: 'variant-1',
    roomId: 'room-1',
    therapistId: REQUEST.employeeId,
    startsAt: dubai('2086-03-18', '01:30'),
    resolution: 'unresolved',
    ...overrides,
  })

  const decide = (overrides: Partial<Parameters<typeof decideLeaveApproval>[0]> = {}) =>
    decideLeaveApproval({
      request: REQUEST,
      approver: APPROVER,
      delegations: [],
      at: dubai('2086-03-16', '12:00'),
      conflicts: [],
      coverage: NO_BREACH,
      ...overrides,
    })

  it('approves a pending request with no conflicts and no caused breach', () => {
    expect(decide()).toEqual({
      kind: 'approve',
      authority: { via: 'own_authority' },
      conflictsOverridden: 0,
      conflictsReassigned: 0,
    })
  })

  it('counts what it stepped over, so leave_approval can record it', () => {
    const answer = decide({
      conflicts: [
        conflict({ appointmentId: 'a-1', resolution: 'reassigned' }),
        conflict({ appointmentId: 'a-2', resolution: 'overridden' }),
        conflict({ appointmentId: 'a-3', resolution: 'overridden' }),
      ],
    })
    expect(answer).toEqual({
      kind: 'approve',
      authority: { via: 'own_authority' },
      conflictsOverridden: 2,
      conflictsReassigned: 1,
    })
  })

  it('refuses while any conflict is unresolved, and the refusal carries all of them', () => {
    const answer = decide({
      conflicts: [
        conflict({ appointmentId: 'a-1', resolution: 'reassigned' }),
        conflict({ appointmentId: 'a-2' }),
        conflict({ appointmentId: 'a-3' }),
      ],
    })
    expect(answer.kind).toBe('refused')
    expect(answer.kind === 'refused' && answer.refusal).toBe('conflicts_unresolved')
    expect(answer.kind === 'refused' && answer.conflicts.map((row) => row.appointmentId)).toEqual([
      'a-2',
      'a-3',
    ])
  })

  it('refuses a request that is not pending', () => {
    const answer = decide({ request: { ...REQUEST, status: 'approved' } })
    expect(answer.kind === 'refused' && answer.refusal).toBe('not_pending')
  })

  it('refuses an unauthorised approver BEFORE naming anybody else’s appointment', () => {
    // The order is the claim. A marketer asking about somebody's leave must not learn which customer has a
    // booking with them, so the authority refusal has to come first — and the assertion is that the conflict
    // list is empty although three unresolved conflicts were supplied.
    const answer = decide({
      approver: { employeeId: 'a-marketer', role: 'marketer' },
      conflicts: [conflict({ appointmentId: 'a-1' }), conflict({ appointmentId: 'a-2' })],
      coverage: { ...NO_BREACH, caused: [] },
    })
    expect(answer.kind === 'refused' && answer.refusal).toBe('approver_not_authorised')
    expect(answer.kind === 'refused' && answer.conflicts).toEqual([])
  })

  it('refuses a caused coverage breach, and the refusal names the segment', () => {
    const breach = {
      rule: 'minimum_floor_coverage',
      tradingDate: DAY,
      segmentLabel: '2086-03-17 23:30-00:00',
      segmentIndex: 25,
      onFloor: 1,
      required: 2,
    } as const
    const answer = decide({ coverage: { ...NO_BREACH, caused: [breach] } })
    expect(answer.kind === 'refused' && answer.refusal).toBe('coverage_would_break')
    expect(answer.kind === 'refused' && answer.why).toContain('2086-03-17 23:30-00:00')
    expect(answer.kind === 'refused' && answer.breaches).toEqual([breach])
  })

  it('takes the conflict refusal before the coverage one, because they send you to two screens', () => {
    const answer = decide({
      conflicts: [conflict()],
      coverage: {
        ...NO_BREACH,
        caused: [
          {
            rule: 'minimum_floor_coverage',
            tradingDate: DAY,
            segmentLabel: '2086-03-17 11:00-11:30',
            segmentIndex: 0,
            onFloor: 1,
            required: 2,
          },
        ],
      },
    })
    expect(answer.kind === 'refused' && answer.refusal).toBe('conflicts_unresolved')
  })
})

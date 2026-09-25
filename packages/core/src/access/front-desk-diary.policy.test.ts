import { describe, expect, it } from 'vitest'
import { decideAppointmentTransition } from '../lifecycle/transitions.ts'
import { ROLE_DEFINITIONS } from './permissions.ts'
import {
  agentPrincipal,
  type Principal,
  principalCan,
  resolvedPermissionsOf,
  staffPrincipal,
} from './principal-policy.ts'
import {
  FRONT_DESK_DIARY_DENIED_CAPABILITIES,
  FRONT_DESK_DIARY_GRANTS,
  FRONT_DESK_DIARY_PRINCIPAL,
} from './principals/front-desk-diary.ts'

/**
 * B-UI-03 — the admin diary's cage, in the policy layer.
 *
 * The two files beside it prove the same three things for the other two principals, and this is their
 * shape on purpose: the resolved set is ENUMERATED rather than asked one question at a time, because
 * `can(x) === false` for six named permissions says those six are absent while an enumeration says what is
 * present — so a fourth capability granted next month is visible to a reader of the expectation rather than
 * silently outside its cases.
 *
 * What is only here: this is the first principal that WRITES from an unauthenticated screen, so the last
 * describe asserts that the ONE write it has is the reschedule and that the neighbouring moves a diary
 * makes look easy — the cancellation and the no-show — are refused by the policy layer rather than by the
 * absence of a control on the page.
 */

const DIARY: Principal = (() => {
  const principal = agentPrincipal(FRONT_DESK_DIARY_PRINCIPAL)
  if (principal === null) throw new Error('the front-desk diary principal is not in the registry')
  return principal
})()

describe('the resolved permission set', () => {
  it('is exactly the two reads and the one write, enumerated', () => {
    expect([...resolvedPermissionsOf(DIARY)].sort()).toEqual([
      'booking:read',
      'booking:reschedule',
      'calendar:read',
    ])
    expect(FRONT_DESK_DIARY_GRANTS).toHaveLength(3)
  })

  it('holds none of the capabilities the record says it must not', () => {
    expect(FRONT_DESK_DIARY_DENIED_CAPABILITIES.length).toBeGreaterThan(0)
    for (const denied of FRONT_DESK_DIARY_DENIED_CAPABILITIES) {
      expect(principalCan(DIARY, denied.permission), denied.permission).toBe(false)
      // Every entry carries its reason, because an absence cannot be reviewed without one.
      expect(denied.why.length, denied.permission).toBeGreaterThan(40)
    }
  })

  it('is NARROWER than the role the screen is named after', () => {
    // The claim `principals/front-desk-diary.ts` is about, asserted by comparing the two sides rather than
    // by restating the receptionist's list, which would go stale silently the moment either widened.
    const desk = staffPrincipal('receptionist')
    for (const permission of [
      'customer:write',
      'till:operate',
      'invoice:issue',
      'booking:cancel',
    ] as const) {
      expect(principalCan(desk, permission), `receptionist ${permission}`).toBe(true)
      expect(principalCan(DIARY, permission), `diary ${permission}`).toBe(false)
    }
    // The control, so the case above is not satisfied by a principal that holds nothing at all: the
    // capability the diary exists for is held by both.
    expect(principalCan(desk, 'booking:reschedule')).toBe(true)
    expect(principalCan(DIARY, 'booking:reschedule')).toBe(true)
  })

  it('is not the system role, which is what it would have inherited', () => {
    // `system` is every background worker in the product. It does NOT hold the reschedule, so modelling the
    // diary as that role would refuse every drag with `transition_forbidden` — and widening the role to fix
    // that would hand the campaign sender the ability to move appointments.
    const system = ROLE_DEFINITIONS.system.permissions
    expect(system).not.toBe('all')
    if (system === 'all') return
    expect([...system]).not.toContain('booking:reschedule')
    expect([...system]).toContain('campaign:send')
    expect(principalCan(DIARY, 'campaign:send')).toBe(false)
    expect(principalCan(DIARY, 'content:write')).toBe(false)
  })

  it('is not the customer link, which holds a different pair', () => {
    // Two unauthenticated surfaces, two different cages: the link may cancel its own booking and may not
    // read the calendar; the diary may read the calendar and may not cancel anything. A shared default
    // would have given both the union, which is the failure the per-principal grant list prevents.
    expect(principalCan(DIARY, 'calendar:read')).toBe(true)
    expect(principalCan(DIARY, 'booking:cancel')).toBe(false)
    const link = agentPrincipal('system:customer_booking_link')
    if (link === null) throw new Error('the customer-link principal is not in the registry')
    expect(principalCan(link, 'calendar:read')).toBe(false)
    expect(principalCan(link, 'booking:cancel')).toBe(true)
  })
})

describe('the lifecycle accepts the principal for the move and refuses the rest', () => {
  it('allows a reschedule with a reason, and the same decision the front desk gets', () => {
    const diary = decideAppointmentTransition(
      'confirmed',
      'rescheduled',
      FRONT_DESK_DIARY_PRINCIPAL,
      'dragged to another time on the admin diary',
    )
    const desk = decideAppointmentTransition(
      'confirmed',
      'rescheduled',
      'receptionist',
      'dragged to another time on the admin diary',
    )
    expect(diary.kind).toBe('allowed')
    // The same DecidedTransition, not merely a permitted one: the permission, the event type and the reason
    // requirement are the transition table's, and a second answer for this surface would be a second
    // lifecycle.
    expect(diary).toEqual(desk)
  })

  it('refuses a reschedule with no reason, identically to staff', () => {
    expect(
      decideAppointmentTransition('confirmed', 'rescheduled', FRONT_DESK_DIARY_PRINCIPAL),
    ).toMatchObject({ kind: 'refused', refusal: 'reason_required' })
  })

  it('refuses the cancellation and the no-show by permission, not by a missing control', () => {
    for (const to of ['cancelled_by_customer', 'cancelled_by_salon', 'no_show'] as const) {
      const refused = decideAppointmentTransition(
        'confirmed',
        to,
        FRONT_DESK_DIARY_PRINCIPAL,
        'a reason, so the refusal cannot be about one',
      )
      expect(refused, to).toMatchObject({ kind: 'refused', refusal: 'transition_forbidden' })
      if (refused.kind !== 'refused') continue
      // The refusal names roles and not principals: a message offering `system:front_desk_diary` as
      // somebody who could have done it would be a lie.
      expect(refused.permittedRoles).not.toContain(FRONT_DESK_DIARY_PRINCIPAL)
    }
  })

  it('still refuses a caller that is neither a role nor a declared principal', () => {
    // Deny by default in both directions, and the control on the widening: a third principal must not have
    // turned the caller into a free-text field. A typo in the id buys nothing.
    for (const caller of [
      'system:front_desk_diaries',
      'system:front_desk_diary ',
      'front_desk_diary',
      '',
    ]) {
      expect(
        decideAppointmentTransition('confirmed', 'rescheduled', caller, 'a reason'),
        caller,
      ).toMatchObject({ kind: 'refused', refusal: 'transition_forbidden' })
    }
  })
})

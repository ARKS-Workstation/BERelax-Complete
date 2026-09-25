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
  CUSTOMER_LINK_DENIED_CAPABILITIES,
  CUSTOMER_LINK_GRANTS,
  CUSTOMER_LINK_PRINCIPAL,
} from './principals/customer-link.ts'

/**
 * B-UI-05 — the magic-link holder's cage, in the policy layer.
 *
 * `seo-agent.policy.test.ts` next door proves the same three things for the other principal, and this file
 * is deliberately its shape: the resolved set is ENUMERATED rather than asked one question at a time,
 * because `can(x) === false` for six named permissions says those six are absent and an enumeration says
 * what is present — so a seventh capability granted next month is visible to a reader of the expectation
 * rather than silently outside its cases.
 *
 * The one thing here that is not in that file is the last describe: the point of this principal is that
 * `decideAppointmentTransition` accepts it, so the link holder's reschedule and the front desk's are one
 * decision. That is asserted against the real decision function rather than against `principalCan`, because
 * the failure it guards is a `can(role, …)` left behind somewhere in the lifecycle — which would refuse
 * every self-service move with `transition_forbidden` and read exactly like a permission that was never
 * granted.
 */

const LINK: Principal = (() => {
  const principal = agentPrincipal(CUSTOMER_LINK_PRINCIPAL)
  if (principal === null) throw new Error('the customer-link principal is not in the registry')
  return principal
})()

describe('the resolved permission set', () => {
  it('is exactly the three booking capabilities, enumerated', () => {
    expect([...resolvedPermissionsOf(LINK)].sort()).toEqual([
      'booking:cancel',
      'booking:read',
      'booking:reschedule',
    ])
    expect(CUSTOMER_LINK_GRANTS).toHaveLength(3)
  })

  it('holds none of the capabilities the record says it must not', () => {
    expect(CUSTOMER_LINK_DENIED_CAPABILITIES.length).toBeGreaterThan(0)
    for (const denied of CUSTOMER_LINK_DENIED_CAPABILITIES) {
      expect(principalCan(LINK, denied.permission), denied.permission).toBe(false)
      // Every entry carries its reason, because an absence cannot be reviewed without one.
      expect(denied.why.length, denied.permission).toBeGreaterThan(40)
    }
  })

  it('is NARROWER than the role it would otherwise have been', () => {
    // The claim `principals/customer-link.ts` is about, asserted directly: `receptionist` was the shortest
    // spelling available and holds three capabilities this principal must not. A test comparing the two
    // sides goes stale silently the moment somebody widens either, which is why it compares them rather
    // than restating the receptionist's list.
    const desk = staffPrincipal('receptionist')
    for (const permission of ['customer:write', 'till:operate', 'invoice:issue'] as const) {
      expect(principalCan(desk, permission), `receptionist ${permission}`).toBe(true)
      expect(principalCan(LINK, permission), `link ${permission}`).toBe(false)
    }
    // And the control, so the case above is not satisfied by a principal that holds nothing at all: the
    // two capabilities the link exists for are held by both.
    for (const permission of ['booking:reschedule', 'booking:cancel'] as const) {
      expect(principalCan(desk, permission), `receptionist ${permission}`).toBe(true)
      expect(principalCan(LINK, permission), `link ${permission}`).toBe(true)
    }
  })

  it('is not the system role, which is what it would have inherited', () => {
    // `system` is every background worker in the product. It does NOT hold the two booking moves, so
    // modelling the link as that role would have refused every self-service reschedule — and it does hold
    // `campaign:send` and `content:write`, so widening the role to fix that would have handed the
    // campaign sender the ability to cancel bookings.
    const system = ROLE_DEFINITIONS.system.permissions
    expect(system).not.toBe('all')
    if (system === 'all') return
    expect([...system]).not.toContain('booking:reschedule')
    expect([...system]).toContain('campaign:send')
    expect(principalCan(LINK, 'campaign:send')).toBe(false)
    expect(principalCan(LINK, 'content:write')).toBe(false)
  })
})

describe('the lifecycle accepts the principal and still refuses what it may not do', () => {
  it('allows the customer their own cancellation, exactly as the front desk gets it', () => {
    const link = decideAppointmentTransition(
      'confirmed',
      'cancelled_by_customer',
      CUSTOMER_LINK_PRINCIPAL,
    )
    const desk = decideAppointmentTransition('confirmed', 'cancelled_by_customer', 'receptionist')
    expect(link.kind).toBe('allowed')
    // The same DecidedTransition, not merely a permitted one: the permission, the event type and the
    // reason requirement are the transition table's and a second answer for the self-service surface would
    // be a second lifecycle.
    expect(link).toEqual(desk)
  })

  it('allows a reschedule with a reason and refuses one without, identically to staff', () => {
    const withReason = decideAppointmentTransition(
      'confirmed',
      'rescheduled',
      CUSTOMER_LINK_PRINCIPAL,
      'customer moved it from the manage-booking page',
    )
    expect(withReason.kind).toBe('allowed')
    const without = decideAppointmentTransition('confirmed', 'rescheduled', CUSTOMER_LINK_PRINCIPAL)
    expect(without).toMatchObject({ kind: 'refused', refusal: 'reason_required' })
    expect(decideAppointmentTransition('confirmed', 'rescheduled', 'receptionist')).toMatchObject({
      kind: 'refused',
      refusal: 'reason_required',
    })
  })

  it('refuses the no-show and the salon cancellation by permission, not by a missing form field', () => {
    for (const to of ['no_show', 'cancelled_by_salon'] as const) {
      const refused = decideAppointmentTransition(
        'confirmed',
        to,
        CUSTOMER_LINK_PRINCIPAL,
        'a reason, so the refusal cannot be about one',
      )
      expect(refused, to).toMatchObject({ kind: 'refused', refusal: 'transition_forbidden' })
      // The refusal names roles and not principals, which is the decision `permittedRolesFor` keeps: a
      // message offering `system:customer_booking_link` as somebody who could have done it would be a lie.
      if (refused.kind !== 'refused') continue
      expect(refused.permittedRoles).not.toContain(CUSTOMER_LINK_PRINCIPAL)
      expect([...(refused.permittedRoles ?? [])]).toEqual(['owner', 'manager'])
    }
  })

  it('still refuses a caller that is neither a role nor a declared principal', () => {
    // Deny by default in both directions, and the control on the widening: accepting a principal id must
    // not have turned the caller into a free-text field. A typo in the id buys nothing.
    for (const caller of [
      'system:customer_booking_links',
      'customer',
      'system:seo_agent ',
      '',
      'intern',
    ]) {
      expect(
        decideAppointmentTransition('confirmed', 'cancelled_by_customer', caller),
        caller,
      ).toMatchObject({ kind: 'refused', refusal: 'transition_forbidden' })
    }
    // And the SEO agent, which is a declared principal and holds no booking capability at all: the
    // widening resolves every principal through its own list rather than through a shared default.
    expect(
      decideAppointmentTransition('confirmed', 'cancelled_by_customer', 'system:seo_agent'),
    ).toMatchObject({ kind: 'refused', refusal: 'transition_forbidden' })
  })

  it('refuses a repeat the principal may not perform, without leaking it as a no-op', () => {
    // The other `can()` call site in the decision, which a widening could easily have missed: a repeat is
    // answered `no_op` for a caller that may act and `transition_forbidden` for one that may not.
    expect(
      decideAppointmentTransition('no_show', 'no_show', CUSTOMER_LINK_PRINCIPAL),
    ).toMatchObject({ kind: 'refused', refusal: 'transition_forbidden' })
    expect(
      decideAppointmentTransition(
        'cancelled_by_customer',
        'cancelled_by_customer',
        CUSTOMER_LINK_PRINCIPAL,
      ),
    ).toMatchObject({ kind: 'no_op' })
  })
})

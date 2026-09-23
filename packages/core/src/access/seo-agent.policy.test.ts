import { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { can, PERMISSIONS, type Permission, ROLE_DEFINITIONS } from './permissions.ts'
import {
  agentPrincipal,
  deniedPermissionOf,
  type Principal,
  PrincipalDenied,
  principalCan,
  resolvedPermissionsOf,
  staffPrincipal,
} from './principal-policy.ts'
import {
  SEO_AGENT_DENIED_CAPABILITIES,
  SEO_AGENT_GRANTS,
  SEO_AGENT_PRINCIPAL,
} from './principals/seo-agent.ts'
import {
  mayPerformPublication,
  PUBLICATION_ACTIONS,
  type PublicationAction,
  performPublication,
  permissionForPublicationAction,
} from './publication.ts'

/**
 * G-SEO-02's proof: publish is refused by the permission layer, and the refusal is not an absence.
 *
 * Three claims, and the order matters because each one closes a way the previous one could be satisfied by
 * accident.
 *
 *   1. **The resolved set.** The whole permission set of `system:seo_agent`, enumerated, with the eight
 *      capabilities the acceptance names asserted absent. On its own this is the weakest of the three: a
 *      principal that resolved to nothing at all would pass it.
 *   2. **The refusal is a refusal, and the effect does not happen.** Every publication action through
 *      `performPublication` raises `PrincipalDenied` from the policy module and leaves an effect counter at
 *      zero. A gate that threw after publishing would satisfy "it threw" and nothing else.
 *   3. **The same call by a permitted principal SUCCEEDS.** Without this, claims 1 and 2 are satisfied by a
 *      matrix that refuses everybody — which is a broken product that passes a security test. This is the
 *      control the brief's rule 3 asks for, and it is the assertion `scripts/test-gates.mjs` case 73c
 *      breaks on purpose.
 *
 * ## Why the call site is asserted and not just the message
 *
 * "Refused at the permission layer" is a claim about WHERE, and every way of stating it without looking at
 * the stack can be satisfied by a route guard that raises the same class. So the test reads the top frame
 * off the error and requires it to be in `access/principal-policy.ts` — and, because an assertion about a
 * stack is exactly the kind that quietly stops discriminating, it runs the same assertion against an error
 * raised by a route-shaped guard defined in this file and requires it to FAIL.
 */

/**
 * The principal under test, resolved through the registry rather than constructed.
 *
 * A throw rather than a non-null assertion: `agentPrincipal` returns null for an id the registry does not
 * declare, and a test that asserted about a `null` principal would report that the seo_agent holds no
 * permissions — which is the answer it is looking for, arrived at by the principal not existing.
 */
const declaredPrincipal = (id: string): Principal => {
  const principal = agentPrincipal(id)
  if (principal === null) throw new Error(`${id} is not declared in the agent-principal registry`)
  return principal
}

const SEO_AGENT = declaredPrincipal(SEO_AGENT_PRINCIPAL)
const OWNER = staffPrincipal('owner')

/** The eight capabilities the acceptance criterion names, in its own words, mapped to the catalogue. */
const DENIED_BY_ACCEPTANCE: Readonly<Record<string, Permission>> = {
  publish: 'content:publish',
  revalidate: 'cache:revalidate',
  sitemap_write: 'sitemap:write',
  redirect_write: 'redirect:write',
  robots_write: 'robots:write',
  noindex_write: 'noindex:write',
  canonical_write: 'canonical:write',
  cms_write: 'content:write',
}

/** The top stack frame of an error, which is where it was constructed. */
const topFrameOf = (error: unknown): string => {
  const stack = error instanceof Error ? (error.stack ?? '') : ''
  const frames = stack.split('\n').filter((line) => line.trimStart().startsWith('at '))
  return frames[0] ?? ''
}

/**
 * A refusal raised the way a route handler raises one: the same class, from a different file.
 *
 * This is the control for the call-site assertion. It is what "the UI refused it" looks like from the
 * outside, and the whole point of the criterion is that it is not the same thing.
 */
function routeShapedGuard(principal: Principal, permission: Permission): never {
  throw new PrincipalDenied(principal, permission)
}

describe('the resolved permission set of system:seo_agent', () => {
  it('excludes publish, revalidate, sitemap, redirect, robots, noindex, canonical and cms writes', () => {
    const resolved = resolvedPermissionsOf(SEO_AGENT)
    for (const [name, permission] of Object.entries(DENIED_BY_ACCEPTANCE)) {
      expect(resolved, `${name} (${permission}) is in the seo_agent's resolved set`).not.toContain(
        permission,
      )
      expect(principalCan(SEO_AGENT, permission), `${name} is granted`).toBe(false)
    }
    // Eight, counted, so a criterion silently reduced to seven cases fails here rather than passing.
    expect(Object.keys(DENIED_BY_ACCEPTANCE)).toHaveLength(8)
  })

  it('is exactly the three declared grants, so a ninth capability cannot arrive unnoticed', () => {
    // The enumeration rather than eight negatives. A permission added to the agent's list next month is a
    // failure of THIS assertion, which is what makes the eight above a floor rather than the whole claim.
    expect([...resolvedPermissionsOf(SEO_AGENT)].sort()).toEqual([
      'catalogue:read',
      'report:read',
      'seo_suggestion:propose',
    ])
    expect(SEO_AGENT_GRANTS).toHaveLength(3)
  })

  it('is narrower than the system ROLE, which holds content:write — so it is not an alias for it', () => {
    // The mistake this unit exists to prevent, asserted from both sides. `system` is every background
    // worker in the product, so its list was written for the campaign sender and the CMS seeder; an agent
    // modelled as that role would inherit content:write and campaign:send and the cage would never have
    // been closed.
    expect(ROLE_DEFINITIONS.system.permissions).toContain('content:write')
    expect(can('system', 'content:write')).toBe(true)
    expect(principalCan(SEO_AGENT, 'content:write')).toBe(false)
    expect(resolvedPermissionsOf(SEO_AGENT).length).toBeLessThan(
      resolvedPermissionsOf(staffPrincipal('system')).length,
    )
  })

  it('every capability the principal declares as denied really is absent', () => {
    // The declared reasons in `principals/seo-agent.ts` are a review artefact and grant nothing. This is
    // what stops them becoming a comment that says one thing while the list says another: an entry moved
    // into the allow list and left in the denied list fails here.
    expect(SEO_AGENT_DENIED_CAPABILITIES.length).toBeGreaterThan(0)
    for (const denied of SEO_AGENT_DENIED_CAPABILITIES) {
      expect(principalCan(SEO_AGENT, denied.permission), denied.permission).toBe(false)
      expect(denied.why.length).toBeGreaterThan(40)
    }
    // And the two lists describe the same eight capabilities, in both directions.
    expect([...SEO_AGENT_DENIED_CAPABILITIES.map((d) => d.permission)].sort()).toEqual(
      [...Object.values(DENIED_BY_ACCEPTANCE)].sort(),
    )
  })

  it('refuses a permission outside the catalogue, and an agent id outside the registry', () => {
    expect(principalCan(SEO_AGENT, 'robots.txt:write' as Permission)).toBe(false)
    // Deny by default for the PRINCIPAL too, which F07 had no notion of: a typo in an agent key must not
    // fall back to a role's grant list.
    expect(agentPrincipal('system:seo_agnet')).toBeNull()
    expect(agentPrincipal('system')).toBeNull()
  })
})

describe('the publication chokepoint refuses the seo_agent at the policy layer', () => {
  it('refuses every publication action and never runs the effect', () => {
    let published = 0
    for (const action of PUBLICATION_ACTIONS) {
      expect(() =>
        performPublication({
          principal: SEO_AGENT,
          action,
          apply: () => {
            published += 1
            return 'published'
          },
        }),
      ).toThrow(PrincipalDenied)
    }
    // The assertion that makes it a denial and not an exception after the fact. A gate that published and
    // then threw would satisfy `toThrow` for all nine actions.
    expect(published).toBe(0)
    expect(PUBLICATION_ACTIONS.length).toBe(9)
  })

  it('the refusal originates in the policy module, by error type and by call site', () => {
    let caught: unknown
    try {
      performPublication({
        principal: SEO_AGENT,
        action: 'publish',
        apply: () => expect.unreachable('the effect must not run'),
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(PrincipalDenied)
    expect(caught).toBeInstanceOf(AppError)
    expect((caught as AppError).kind).toBe('forbidden')
    expect((caught as AppError).details['code']).toBe('principal_denied')
    expect(deniedPermissionOf(caught)).toBe('content:publish')
    // The call site. The frame nearest the throw is in the policy module — not in `publication.ts`, which
    // performs no decision, and not in a route.
    expect(topFrameOf(caught)).toContain('access/principal-policy.ts')
    expect(topFrameOf(caught)).not.toContain('publication.ts')
  })

  it('the control: the same refusal raised by a route-shaped guard does NOT pass the call-site check', () => {
    // Without this, the assertion above could stop discriminating — a stack read that always returned the
    // policy module's path would report a pass for a refusal raised anywhere at all.
    let caught: unknown
    try {
      routeShapedGuard(SEO_AGENT, 'content:publish')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(PrincipalDenied)
    expect(topFrameOf(caught)).toContain('seo-agent.policy.test.ts')
    expect(topFrameOf(caught)).not.toContain('access/principal-policy.ts')
  })

  it('a permitted principal performs every one of the same nine actions', () => {
    // Claim 3. The refusal above is a decision about the seo_agent and not a matrix that refuses everybody.
    let published = 0
    for (const action of PUBLICATION_ACTIONS) {
      const result = performPublication({
        principal: OWNER,
        action,
        apply: () => {
          published += 1
          return action
        },
      })
      expect(result).toBe(action)
    }
    expect(published).toBe(PUBLICATION_ACTIONS.length)
  })

  it('the boolean a screen reads agrees with the gate, for both principals and every action', () => {
    // Two spellings of one decision is how a screen comes to offer a button the API refuses. This asserts
    // they cannot disagree by asking both about all nine actions.
    for (const action of PUBLICATION_ACTIONS) {
      expect(mayPerformPublication(SEO_AGENT, action), action).toBe(false)
      expect(mayPerformPublication(OWNER, action), action).toBe(true)
    }
  })

  it('every publication action maps to a declared permission, and publish and unpublish share one', () => {
    const catalogue = new Set<string>(PERMISSIONS)
    for (const action of PUBLICATION_ACTIONS) {
      expect(catalogue.has(permissionForPublicationAction(action)), action).toBe(true)
    }
    // Taking a live page down is as consequential as putting one up; a rule that gated only the way in
    // would let anybody with content:write remove the homepage.
    expect(permissionForPublicationAction('unpublish')).toBe(
      permissionForPublicationAction('publish'),
    )
    // And no action is gated by a permission an interactive non-owner role holds by accident.
    const actionPermissions = new Set(
      PUBLICATION_ACTIONS.map((action: PublicationAction) =>
        permissionForPublicationAction(action),
      ),
    )
    expect(actionPermissions.size).toBe(8)
  })
})

import { AppError } from '@berelax/shared'
import { PERMISSIONS, type Permission, ROLE_DEFINITIONS, type Role } from './permissions.ts'
import {
  AGENT_PRINCIPAL_GRANTS,
  type AgentPrincipalId,
  isAgentPrincipalId,
} from './principals/registry.ts'

/**
 * The policy layer. One function decides whether a caller may do a thing, and it is this one.
 *
 * F07 put the matrix in `./permissions.ts` and answered `can(role, permission)`. That is still the whole
 * matrix; what this module adds is the other kind of caller. A background agent is not a member of staff
 * with a job title, and modelling it as one is how it comes to hold the capabilities of every other
 * background job in the product (see `./principals/seo-agent.ts` on `ROLE_DEFINITIONS.system`).
 *
 * ## Why the refusal lives here and not at a call site
 *
 * G-SEO-02's point, stated as plainly as it can be: *a check in a route handler that a second caller can
 * skip is not the permission layer.* The publication chokepoint in `./publication.ts` does not decide
 * anything — it calls {@link assertPrincipalMay} and lets the error through — so there is one place the
 * refusal can come from, and `seo-agent.policy.test.ts` asserts that the error it catches was raised HERE,
 * by type and by call site. A guard that re-implemented the decision would pass a test asserting "a 403
 * came back" and would be a second authorisation matrix, which is to say one that will disagree.
 *
 * ## Deny by default, in both directions
 *
 * An unknown permission string is refused (F07 already did this). An unknown *principal* is refused too,
 * which F07 had no notion of: an agent id that is not in the registry resolves to the empty set rather than
 * to the `system` role, because the failure mode of the alternative is a typo in an agent key silently
 * buying a role's whole grant list.
 *
 * ## Purity
 *
 * No clock, no I/O, no ids, no session. It answers "may this principal do this?" over frozen data, which is
 * what lets the entire cage be proved by unit tests and what makes the proof cheap enough to run on every
 * commit.
 */

/**
 * Who is asking.
 *
 * A discriminated union rather than an optional `role` and an optional `agent`, so there is no value of
 * this type that is both, neither, or half of each — the three states a pair of optional fields admits and
 * that a `??` at a call site then resolves in whichever direction the author happened to write first.
 */
export type Principal =
  | { readonly kind: 'staff'; readonly role: Role }
  | { readonly kind: 'agent'; readonly agent: AgentPrincipalId }

/** The staff principal for a role. A helper, so a call site does not spell the discriminant. */
export function staffPrincipal(role: Role): Principal {
  return { kind: 'staff', role }
}

/**
 * The agent principal for an id, or `null` for an id the registry does not declare.
 *
 * `null` rather than a throw, and rather than a principal with an empty set: a caller handed an
 * unrecognised agent key has a configuration bug, and the two ways of hiding it are a principal that is
 * refused everything (which reads as "the cage works") and an exception at a call site that catches it.
 */
export function agentPrincipal(id: string): Principal | null {
  return isAgentPrincipalId(id) ? { kind: 'agent', agent: id } : null
}

/** A stable label for a principal, for a message and for an audit row. Never a person's name. */
export function principalLabel(principal: Principal): string {
  return principal.kind === 'staff' ? `role "${principal.role}"` : `principal "${principal.agent}"`
}

/**
 * The FULL resolved permission set, as the enumeration test reads it.
 *
 * Returned as a set rather than answered one question at a time because that is the assertion the
 * acceptance criterion asks for and because it is the stronger one: `can(x) === false` for eight named
 * permissions says those eight are absent, and an enumeration says what IS present — so a ninth capability
 * granted to the agent next month is visible to a reader of the test's expectation rather than silently
 * outside its eight cases.
 *
 * The wildcard role resolves to every declared permission. An agent's list is filtered through the
 * catalogue, so a grant naming a permission that no longer exists resolves to nothing instead of to a
 * string that `can()` would refuse anyway — the two differ only in whether the enumeration tells you.
 */
export function resolvedPermissionsOf(principal: Principal): readonly Permission[] {
  if (principal.kind === 'staff') {
    const definition = ROLE_DEFINITIONS[principal.role]
    return definition.permissions === 'all' ? PERMISSIONS : definition.permissions
  }
  const declared = AGENT_PRINCIPAL_GRANTS[principal.agent]
  const catalogue = new Set<string>(PERMISSIONS)
  return Object.freeze(declared.filter((permission) => catalogue.has(permission)))
}

/** Whether the principal holds the permission. Deny by default, including for an unknown string. */
export function principalCan(principal: Principal, permission: Permission): boolean {
  if (!(PERMISSIONS as readonly string[]).includes(permission)) return false
  return resolvedPermissionsOf(principal).includes(permission)
}

/**
 * The refusal, raised by {@link assertPrincipalMay} and by nothing else.
 *
 * A named class rather than a bare `AppError` so a test can assert the refusal came from the policy layer
 * by TYPE, not by matching a sentence — and so a route can turn it into a 403 without reading a message.
 * `kind: 'forbidden'` matches `assertCan`, because a caller that maps error kinds to status codes must not
 * have to learn a second mapping for the same answer.
 *
 * `userFacing` is deliberately false. The person who would read it is not the caller: an agent refused a
 * capability is an operational event, and the sentence names the permission, which is an internal
 * vocabulary.
 */
export class PrincipalDenied extends AppError {
  readonly permission: Permission
  readonly principal: Principal
  constructor(principal: Principal, permission: Permission) {
    super('forbidden', `${principalLabel(principal)} may not ${permission}`, {
      details: {
        code: 'principal_denied',
        permission,
        principal: principal.kind === 'staff' ? principal.role : principal.agent,
        principalKind: principal.kind,
      },
    })
    this.name = 'PrincipalDenied'
    this.permission = permission
    this.principal = principal
  }
}

/**
 * Throws {@link PrincipalDenied} unless the principal holds the permission.
 *
 * Every publication path reaches this. It is the only function in the repository that raises
 * `PrincipalDenied`, which is what makes "the refusal originated in the policy module" a checkable claim
 * rather than a description: the test reads the call site off the stack, and `scripts/test-gates.mjs` case
 * 73 proves that reading can fail by moving the refusal.
 */
export function assertPrincipalMay(principal: Principal, permission: Permission): void {
  if (principalCan(principal, permission)) return
  throw new PrincipalDenied(principal, permission)
}

/** The permission a refusal names, or null — so a caller branches on the answer, not on a message. */
export function deniedPermissionOf(error: unknown): Permission | null {
  return error instanceof PrincipalDenied ? error.permission : null
}

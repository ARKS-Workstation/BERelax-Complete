import type { Permission } from '../permissions.ts'
import { SEO_AGENT_GRANTS, SEO_AGENT_PRINCIPAL } from './seo-agent.ts'

/**
 * The agent principals, as data.
 *
 * One row per non-interactive caller that needs its own, narrower grant set than the `system` role
 * carries. There is exactly one today — G-SEO-02's, the unit that needed the mechanism — and the registry
 * exists rather than the single constant because the second one is the dangerous one: the review
 * autoresponder and the campaign sender are also `system` today, and the way an agent comes to hold a
 * capability nobody granted it is by joining a role whose list was written for somebody else.
 *
 * ## Why this file is separate from the policy that reads it
 *
 * Direction. `seo-agent.ts` imports the `Permission` type from `../permissions.ts`; `../principal-policy.ts`
 * imports both this registry and the catalogue. Declaring the registry inside `permissions.ts` instead
 * would make `permissions.ts` import `seo-agent.ts` and `seo-agent.ts` import `permissions.ts`, which is a
 * cycle — and `no-circular` in `.dependency-cruiser.cjs` is an error, correctly: a cycle here would make
 * the initialisation order of the authorisation matrix undefined.
 */

/** Every declared agent principal id. Deny-by-default applies to an id that is not in this list. */
export const AGENT_PRINCIPALS = [SEO_AGENT_PRINCIPAL] as const
export type AgentPrincipalId = (typeof AGENT_PRINCIPALS)[number]

/**
 * The grant list for each agent principal.
 *
 * `Object.freeze` rather than a bare object literal so that a caller holding a reference cannot push onto
 * it at runtime, which is what "the permission set contains no write capability at all" has to mean if a
 * test is to prove anything: a frozen list cannot be widened by the code under test between the
 * enumeration and the refusal.
 */
export const AGENT_PRINCIPAL_GRANTS: Readonly<Record<AgentPrincipalId, readonly Permission[]>> =
  Object.freeze({
    [SEO_AGENT_PRINCIPAL]: SEO_AGENT_GRANTS,
  })

/** True for a declared agent principal id, so an undeclared one is refused rather than defaulted. */
export function isAgentPrincipalId(value: string): value is AgentPrincipalId {
  return (AGENT_PRINCIPALS as readonly string[]).includes(value)
}

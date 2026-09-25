import type { Permission } from '../permissions.ts'
import { CUSTOMER_LINK_GRANTS, CUSTOMER_LINK_PRINCIPAL } from './customer-link.ts'
import { FRONT_DESK_DIARY_GRANTS, FRONT_DESK_DIARY_PRINCIPAL } from './front-desk-diary.ts'
import { SEO_AGENT_GRANTS, SEO_AGENT_PRINCIPAL } from './seo-agent.ts'

/**
 * The agent principals, as data.
 *
 * One row per non-interactive caller that needs its own, narrower grant set than the `system` role
 * carries. G-SEO-02's was the first, and this registry existed rather than a single constant because the
 * second one is the dangerous one: the review autoresponder and the campaign sender are also `system`
 * today, and the way an agent comes to hold a capability nobody granted it is by joining a role whose list
 * was written for somebody else.
 *
 * B-UI-03's is the third, and it is the first one that WRITES: the admin diary has no session until
 * W-SYS-01, so the row recording who moved an appointment names the SCREEN rather than a member of staff
 * nobody signed in as. `./front-desk-diary.ts` records why `receptionist` and `system` are both wrong there,
 * and what W-SYS-01 replaces.
 *
 * B-UI-05's is the second, and it arrived exactly the way that comment predicted. A magic-link holder is
 * not a member of staff with a job title, and the shortest spelling available was `role: 'receptionist'` —
 * which holds `customer:write`, `till:operate` and `invoice:issue` beside the two booking moves the link
 * needs. `./customer-link.ts` records that and the two other spellings considered. Both principals resolve
 * through `resolvedPermissionsOf`, which reads the list below and nothing else.
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
export const AGENT_PRINCIPALS = [
  CUSTOMER_LINK_PRINCIPAL,
  FRONT_DESK_DIARY_PRINCIPAL,
  SEO_AGENT_PRINCIPAL,
] as const
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
    [CUSTOMER_LINK_PRINCIPAL]: CUSTOMER_LINK_GRANTS,
    [FRONT_DESK_DIARY_PRINCIPAL]: FRONT_DESK_DIARY_GRANTS,
    [SEO_AGENT_PRINCIPAL]: SEO_AGENT_GRANTS,
  })

/** True for a declared agent principal id, so an undeclared one is refused rather than defaulted. */
export function isAgentPrincipalId(value: string): value is AgentPrincipalId {
  return (AGENT_PRINCIPALS as readonly string[]).includes(value)
}

import type { Permission } from '../permissions.ts'

/**
 * The `system:seo_agent` principal: the cage, built before the animal.
 *
 * docs/07 §3 is one sentence and it is a design constraint rather than a preference: the SEO agent stays
 * *"propose-only, with publish denied at the permission layer — not a prompt instruction, an API
 * permission"*. §2 puts the same rule in the compliance-locked tier, beside consent gating and the
 * banned-claims lexicon: *"anything that can be switched off eventually will be"*.
 *
 * ## Why this is a principal and NOT the `system` role
 *
 * The obvious spelling is `role: 'system'`, and it is wrong in the one way that matters. `ROLE_DEFINITIONS.
 * system` holds `content:write` and `campaign:send`, because that role is every background worker in the
 * product — the campaign sender genuinely does send campaigns and the CMS seeder genuinely does write
 * content. An agent that authenticated as `system` would inherit both, so the cage would be open before
 * anybody wrote a line of the agent, and the only thing standing between an LLM and the live site would be
 * the wording of a prompt.
 *
 * So an agent principal is not a role and does not resolve through one. It carries its OWN grant list,
 * which is a closed set of three entries, and `resolvedPermissionsOf` in `../principal-policy.ts` reads that
 * list and nothing else. `seo-agent.policy.test.ts` asserts the difference directly — `content:write` is in
 * the `system` role's set and absent from this one — because "the agent is narrower than the role" is a
 * claim that goes stale silently the moment somebody widens either side.
 *
 * ## Why the denied set is written down as well
 *
 * Deny-by-default already refuses everything not in {@link SEO_AGENT_GRANTS}, so {@link
 * SEO_AGENT_DENIED_CAPABILITIES} grants nothing and forbids nothing. It exists because an absence cannot be
 * reviewed. A reader of a four-line allow list cannot tell whether `robots:write` is missing because
 * somebody decided it must be, or because nobody thought of it — and those two are the same bytes. The
 * denied list is the decision, with the reason attached, and the policy test asserts that every entry in it
 * really is absent from the resolved set. If the two ever disagree, the test fails: an entry added to the
 * allow list and left in the denied list is exactly the change this unit exists to stop.
 */

/** The principal id. Namespaced `system:` because there is no interactive login behind it. */
export const SEO_AGENT_PRINCIPAL = 'system:seo_agent' as const

/**
 * Everything the SEO agent may do. Three entries, and two of them are reads.
 *
 * `catalogue:read` is not optional and is not generosity: G-SEO-03's content-gap analysis decides whether a
 * query already has a dedicated treatment route, so a query it cannot match to the catalogue becomes a
 * content-gap brief for a page that already exists. `report:read` is the weekly worklist it produces and
 * then reads back to diff. `seo_suggestion:propose` is the one write, and it writes to a queue a human
 * empties.
 *
 * `settings:read` is deliberately NOT here. The agent's own configuration reaches it as arguments — the
 * provider, the caps, the property — which is the same reason `packages/core` takes the clock as an
 * argument: a principal that can read the settings table can read the settings of everything else in it.
 */
export const SEO_AGENT_GRANTS: readonly Permission[] = Object.freeze([
  'catalogue:read',
  'report:read',
  'seo_suggestion:propose',
  // The GSC warehouse is the agent's own data and needs no permission to read; there is no
  // `warehouse:read` in the catalogue and inventing one here would be a fourth grant that gates nothing.
])

/** One capability the agent must not hold, and the reason it must not. */
export interface DeniedCapability {
  readonly permission: Permission
  /** Why. Read by nothing — this is the review artefact, and it is the point of the record. */
  readonly why: string
}

/**
 * The eight capabilities G-SEO-02's acceptance names, each with the specific loss it would allow.
 *
 * Ordered as the acceptance criterion lists them, so a reviewer can read the two side by side.
 */
export const SEO_AGENT_DENIED_CAPABILITIES: readonly DeniedCapability[] = Object.freeze([
  {
    permission: 'content:publish',
    why:
      'publish. An LLM that can publish to a live site can publish copy the licence does not permit — ' +
      'docs/07 §3 — and the banned-claims lint is not a defence against a caller that can reach the ' +
      'published state directly. Publication is a named human act against a content hash (W-SITE-10).',
  },
  {
    permission: 'cache:revalidate',
    why:
      'revalidate. The one capability that reaches the public with no row changing: an agent holding it ' +
      'could push a draft live by invalidating the cache in front of it, which leaves no publication ' +
      'record and nothing for an approver to have approved.',
  },
  {
    permission: 'sitemap:write',
    why:
      'sitemap_write. A sitemap is what a crawler is told to fetch; removing a URL from it is a quiet ' +
      'de-indexing that shows up weeks later as lost traffic and never as an error.',
  },
  {
    permission: 'redirect:write',
    why:
      'redirect_write. A 301 from a page that still ranks moves its authority somewhere else and cannot ' +
      'be undone from the crawler’s side. docs/09 §"Technical SEO" says there is real traffic here to ' +
      'lose, and 0029’s one-hop chain rules constrain the shape of a redirect, not who may write one.',
  },
  {
    permission: 'robots:write',
    why:
      'robots_write. One line — Disallow: / — removes the whole site from every crawler that honours it, ' +
      'and docs/09 §"LLM SEO" makes the AI-crawler policy in that file a strategic decision the owner ' +
      'takes, not an optimisation.',
  },
  {
    permission: 'noindex:write',
    why:
      'noindex_write. The single most destructive edit available on a website, and the one an agent ' +
      'optimising a quality metric has the clearest short-term reason to make: de-indexing a thin page ' +
      'improves the average.',
  },
  {
    permission: 'canonical:write',
    why:
      'canonical_write. A canonical pointing away from a page hands its ranking to the target, and a ' +
      'canonical is invisible to everybody who is not reading the source.',
  },
  {
    permission: 'content:write',
    why:
      'cms_write. The agent drafts into its own suggestion queue, never into the CMS. This is the entry ' +
      'that would arrive by accident rather than by decision: `ROLE_DEFINITIONS.system` holds ' +
      'content:write, so an agent modelled as the system ROLE would hold it too — which is why an agent ' +
      'principal does not resolve through a role.',
  },
])

import type { Permission } from './permissions.ts'
import { assertPrincipalMay, type Principal } from './principal-policy.ts'

/**
 * The publication chokepoint: the one function a caller goes through to make something public.
 *
 * ## What this module is, and what W-SITE-10 still owns
 *
 * It authorises a publication and nothing else. The draft → lint_passed → approved → published state
 * machine, the banned-claims lint, the named approval against a content hash and the append-only
 * publication record belong to W-SITE-10, which is `todo`; that unit's own acceptance carries the line *"the
 * SEO agent's role grant set excludes the publish permission … and an explicit publish attempt with that
 * credential returns 403"*, which is this unit's job done from the other end. G-SEO-02 builds the cage
 * first, on purpose — an authorisation layer added after the thing it authorises is an authorisation layer
 * added after the first caller that did not use it. See the `NOTE:` on G-SEO-02 in `build/manifest.yaml`.
 *
 * So there is deliberately nothing here that publishes. `apply` is the caller's effect, and this module
 * does not know or care what it does.
 *
 * ## Why the effect is a thunk and not a boolean
 *
 * The obvious shape is `if (mayPublish(principal)) publish()`, and it is the shape the brief warns about: a
 * boolean handed back to a caller is a check the NEXT caller can forget, and the caller who forgets is by
 * definition the one who did not know there was a check. Passing the effect INTO the gate inverts that —
 * the only way to reach `apply` through this module is to have been authorised first, and a refusal cannot
 * be a no-op because there is no statement after it.
 *
 * What that does not claim: JavaScript cannot make a function unreachable, and a caller holding its own
 * reference to the same effect can still invoke it. That half is a dependency rule rather than a type —
 * `seo-agent-must-not-reach-a-publish-path` in `.dependency-cruiser.cjs` forbids the SEO agent's modules
 * from importing a publication, cache-revalidation or redirect-writing path at all, so the agent's code
 * cannot hold such a reference in the first place. The two together are the cage: it may not, and it cannot
 * reach the thing it may not do.
 *
 * ## Purity
 *
 * `apply` is a caller's function and may do anything; this module does nothing but call it. That is why
 * `performPublication` is generic over the return type and why there is no `await` here — a gate that
 * awaited would decide the concurrency of every caller's publish, which is not a decision authorisation
 * gets to make.
 */

/**
 * The publication surfaces, as one closed vocabulary.
 *
 * Named as G-SEO-02's acceptance criterion names them rather than as the permission strings they map to,
 * because these are the words the criterion, docs/07 §3 and a reviewer use — and because the mapping is the
 * interesting part: `unpublish` and `publish` are the same permission, and `cms_write` is a different one
 * from `publish` even though both end at the CMS.
 */
export const PUBLICATION_ACTIONS = [
  'publish',
  'unpublish',
  'revalidate',
  'sitemap_write',
  'redirect_write',
  'robots_write',
  'noindex_write',
  'canonical_write',
  'cms_write',
] as const
export type PublicationAction = (typeof PUBLICATION_ACTIONS)[number]

/**
 * Which permission each action requires.
 *
 * `unpublish` requires `content:publish`, the same as `publish`, for the reason
 * `apps/web/src/payload/access.ts` already records about Payload's status hook: taking a live page down is
 * as consequential as putting one up, and a rule that gated only the way in would let anybody holding
 * `content:write` remove the homepage.
 *
 * A total record rather than a `switch`, so adding a member to {@link PUBLICATION_ACTIONS} without deciding
 * its permission is a type error rather than a `default` arm — and a `default` arm in a mapping like this
 * one is how an action comes to be gated by whichever permission happened to be the fallback.
 */
export const PERMISSION_FOR_PUBLICATION_ACTION: Readonly<Record<PublicationAction, Permission>> =
  Object.freeze({
    publish: 'content:publish',
    unpublish: 'content:publish',
    revalidate: 'cache:revalidate',
    sitemap_write: 'sitemap:write',
    redirect_write: 'redirect:write',
    robots_write: 'robots:write',
    noindex_write: 'noindex:write',
    canonical_write: 'canonical:write',
    cms_write: 'content:write',
  })

/** The permission an action requires. Exported so a refusal message and an audit row agree. */
export function permissionForPublicationAction(action: PublicationAction): Permission {
  return PERMISSION_FOR_PUBLICATION_ACTION[action]
}

/**
 * Authorises one publication action and performs it, or raises the policy layer's refusal.
 *
 * Deliberately has no `try` around `apply`: a failure inside the effect is the caller's failure and must
 * reach them unchanged. Wrapping it would make a genuine publication error indistinguishable from a
 * refusal, which is the one distinction every caller of this function needs.
 */
export function performPublication<T>(args: {
  readonly principal: Principal
  readonly action: PublicationAction
  readonly apply: () => T
}): T {
  assertPrincipalMay(args.principal, permissionForPublicationAction(args.action))
  return args.apply()
}

/** Whether the principal may perform the action. For a screen that greys a button rather than refusing. */
export function mayPerformPublication(principal: Principal, action: PublicationAction): boolean {
  try {
    assertPrincipalMay(principal, permissionForPublicationAction(action))
    return true
  } catch {
    /*
     * A boolean derived from the throw rather than from a second call to `principalCan`, and that is the
     * whole reason this function exists here rather than at a call site. Two spellings of one decision is
     * how a screen comes to offer a button the API then refuses — or worse, hides one the API would have
     * allowed. This cannot diverge from `performPublication`, because it asks the same function.
     */
    return false
  }
}

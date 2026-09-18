/**
 * Where the CMS lives in the URL space, and the header that keeps it out of the index.
 *
 * Declared here rather than in `apps/web` because two other units have to agree with it without
 * importing the app: W-SITE-01 owns the public route registry and must be able to assert that none of
 * these prefixes is in it, and W-SITE-10 owns the sitemaps and must be able to exclude them. A list each
 * of them wrote separately is a list that stops matching the day the admin path changes.
 */

/**
 * Payload's admin and its REST/GraphQL API.
 *
 * The API is `/cms-api`, not Payload's default `/api`. `/api` belongs to the application — `/api/facts`
 * is a documented public endpoint (docs/09) — and Payload's API route is a catch-all, so mounting it at
 * `/api` would put a catch-all in one root layout group and a static sibling in another. Renaming it
 * costs one config line and removes the whole question.
 */
export const CMS_ROUTE_PREFIXES = ['/admin', '/cms-api'] as const
export type CmsRoutePrefix = (typeof CMS_ROUTE_PREFIXES)[number]

export const PAYLOAD_ADMIN_ROUTE = '/admin' as const
export const PAYLOAD_API_ROUTE = '/cms-api' as const

/**
 * The value every CMS response carries.
 *
 * `noindex` alone is not enough. `nofollow` stops a crawler that found a login page from walking into
 * every collection listing behind it, and `noarchive` stops a cached copy of an admin screen — which may
 * carry unpublished copy — outliving the page. All three, on one header, because a crawler that ignores
 * robots.txt still honours this one: it is served with the response rather than fetched separately.
 */
export const CMS_ROBOTS_TAG = 'noindex, nofollow, noarchive' as const
export const ROBOTS_HEADER_NAME = 'x-robots-tag' as const

/** True for the prefix itself and for anything under it; false for a path that merely starts with the letters. */
export function isCmsRoute(pathname: string): boolean {
  return CMS_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  )
}

/**
 * Asserts a set of public routes contains none of the CMS's.
 *
 * Exported for W-SITE-01's registry test and W-SITE-10's sitemap test to call, so the exclusion is
 * checked by the units that could break it rather than only by this one.
 */
export function cmsRoutesIn(paths: Iterable<string>): readonly string[] {
  return [...paths].filter((path) => isCmsRoute(path))
}

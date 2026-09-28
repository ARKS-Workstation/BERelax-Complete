import { ADMIN_GROUP_PREFIXES } from './registry.ts'

/**
 * Which URLs belong to the admin estate, and which of them need a session — W-SYS-11.
 *
 * ## Why this is not a list of routes
 *
 * The `(admin)` route group contributes nothing to the URL, so its 25 routes are top-level paths that
 * share no single prefix. A list of them here would be a second copy of the filesystem, and every
 * separately maintained copy of that list has the same failure: a route is added, the list is not, and the
 * omission is invisible — which for this list means an admin screen that is served to anybody.
 *
 * So the rule is a PREDICATE over prefixes, and {@link ADMIN_GROUP_PREFIXES} is the registry's own list of
 * them, already maintained because the `x-robots-tag` policy needs exactly the same set. Seven prefixes
 * cover 22 of the 25 routes. The other three are top-level paths that claim no prefix and are named in
 * {@link ADMIN_STANDALONE_PATHS}.
 *
 * ## What stops that being a hand-written list that goes stale
 *
 * `apps/web/src/admin-guard.test.ts` walks the `(admin)` directory and asserts that this predicate matches
 * **exactly** the routes on disk, in both directions: every file under `(admin)/` is claimed, and nothing
 * claimed is absent. So a route added under one of the seven prefixes is covered the moment it exists, and
 * a route added outside them fails a test that names the path and the file — the fix being to declare it
 * here, which is a line of code somebody has to write deliberately.
 *
 * The other direction matters as much and is the one that would rot quietly: a prefix declared here for a
 * route that no longer exists would make the predicate claim URLs nothing serves. The same test refuses it.
 *
 * ## Two layers, and neither is the other's backup
 *
 * `apps/web/proxy.ts` uses {@link requiresAdminSession} to refuse a request with no session cookie before
 * any route runs. That is what makes a route added later refused BY DEFAULT rather than refused once
 * somebody remembers to add a guard.
 *
 * It is NOT the authentication. The proxy cannot reach the database, so it can only see whether a cookie is
 * *present* — a syntactically valid cookie naming no row sails past it. The authoritative check is
 * `requireAdminPrincipal` inside each handler, which resolves the cookie against a row. Relying on
 * middleware for authorisation is how CVE-2025-29927 worked, and the reason a bypass of the edge is
 * uninteresting here is that the edge was never the thing deciding.
 */

/**
 * Admin routes whose path sits under none of the group's prefixes.
 *
 * Three today. Each is a top-level path that claims no prefix of its own, which is why the registry did not
 * already have a prefix for it: `/calendar` is B-UI-03's front-desk diary, `/quick-book` is B-UI-04's
 * walk-in screen, and `/login` is this unit's. A prefix for any of them would be a claim on paths nothing
 * serves.
 *
 * Exact paths, matched whole, and NOT prefixes: `/calendar` must not claim `/calendars` or some future
 * public `/calendar-feed`. {@link isAdminPath} compares them by equality for that reason.
 */
export const ADMIN_STANDALONE_PATHS: readonly string[] = ['/calendar', '/login', '/quick-book']

/**
 * The admin paths that do NOT require a session.
 *
 * Exactly one, and it has to be: the sign-in screen cannot be behind the sign-in. It is named here rather
 * than being recognisable by the absence of a guard in its handler, because those two states look identical
 * from outside and one of them is a defect. `admin-guard.test.ts` asserts this array's length is 1, so a
 * second unguarded admin route is a failing test and a deliberate decision rather than an omission.
 */
export const ADMIN_UNGUARDED_PATHS: readonly string[] = ['/login']

/** Does this path belong to the admin estate at all? */
export function isAdminPath(pathname: string): boolean {
  if (ADMIN_STANDALONE_PATHS.includes(pathname)) return true
  return ADMIN_GROUP_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  )
}

/**
 * Does a request for this path need a live admin session?
 *
 * Every admin path except the sign-in screen. Written as "admin and not exempt" rather than as a list of
 * guarded paths, because the default has to be *guarded*: with the list the other way round, a new route is
 * open until somebody adds it.
 */
export function requiresAdminSession(pathname: string): boolean {
  if (!isAdminPath(pathname)) return false
  return !ADMIN_UNGUARDED_PATHS.includes(pathname)
}

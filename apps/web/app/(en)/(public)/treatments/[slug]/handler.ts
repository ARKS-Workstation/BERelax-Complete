import { resolveServicePath, type Sql } from '@berelax/db'

/**
 * `GET /treatments/<slug>` — resolve a catalogue path: the service, a 301, or a 404.
 *
 * ## Why this route exists now, in this shape
 *
 * B-CAT-05 writes a `redirect_map` row whenever a slug moves, and the claim that matters is not "a row
 * was inserted" but "the old URL still reaches the treatment". A redirect nothing serves is a row in a
 * table; a redirect pointing at a slug that no longer resolves is a 404 with extra steps, and both look
 * identical to a test that only reads the database. So this handler answers both halves — the 301 and
 * the 200 it lands on — and `apps/web/src/treatment-path.itest.ts` asserts the pair against a real
 * PostgreSQL.
 *
 * W-SITE-05 owns the real page at this path and supersedes this file: a rendered `page.tsx` cannot
 * coexist with a `route.ts` in the same segment, so that unit deletes the route and moves the
 * resolution into the page (a `redirect()` for the 301, `notFound()` for the 404). Until then a live
 * service answers with `text/plain` and its public display name, which is deliberately not markup — a
 * placeholder that could be mistaken for the treatment page is worse than one that obviously is not.
 *
 * ## Why the handler takes its dependencies
 *
 * Same reason as `api/v1/otp/handler.ts`: the integration suite drives this function directly with its
 * own connection, so the assertions are about the resolution rather than about a production server's
 * startup. `route.ts` next door builds the real connection once.
 *
 * ## Scope
 *
 * The English path only. `/ar/treatments/...` is a second root layout (`app/(ar)`) and W-SITE-05 mounts
 * the localised route; the redirect map is locale-agnostic and W-SITE-09's middleware is what will
 * preserve the prefix.
 */

export interface TreatmentPathDeps {
  readonly sql: Sql
}

/**
 * A 301 is cached by browsers indefinitely by default, which is correct for a rename and wrong the day
 * somebody renames back. A short max-age with `must-revalidate` keeps the redirect cheap without making
 * a mistake permanent in every browser that saw it.
 */
const REDIRECT_CACHE_CONTROL = 'public, max-age=300, must-revalidate'

export async function handleTreatmentPath(
  deps: TreatmentPathDeps,
  request: Request,
): Promise<Response> {
  // The stored paths are absolute and unprefixed — `/treatments/<slug>` — and the query string is not
  // part of the identity of a page, so it is dropped before the lookup and the redirect keeps it.
  const url = new URL(request.url)
  const resolution = await resolveServicePath(deps.sql, url.pathname)

  if (resolution.kind === 'redirect') {
    const location = resolution.target + url.search
    return new Response(null, {
      status: resolution.status,
      headers: { location, 'cache-control': REDIRECT_CACHE_CONTROL },
    })
  }

  if (resolution.kind === 'service') {
    return new Response(resolution.service.publicDisplayName, {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }

  // An archived service lands here rather than on a 301, because `archiveService` retargets what
  // pointed at its path to the treatments index and writes no row for the service's own path. W-SITE-05
  // turns this into the 301 to /treatments its acceptance names; a 404 in the meantime is honest about
  // there being no page, where a 301 to a page that does not exist yet would not be.
  return new Response(null, { status: 404 })
}

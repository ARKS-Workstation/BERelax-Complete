import { isAppError } from '@berelax/shared'
import { revalidatePath } from 'next/cache'
import {
  CATALOGUE_CHANGE_KINDS,
  type CatalogueChange,
  type CatalogueChangeKind,
  runCatalogueRevalidation,
} from '../../../../../src/revalidate/catalogue.ts'

/**
 * `POST /settings/catalogue/revalidate` — the publish loop's trigger.
 *
 * The catalogue-derived routes are prerendered from the database, so a price raised in the admin does not
 * reach them by itself: something has to invalidate the cached copies. docs/09 §5 states the mechanism —
 * *"a change propagates by on-demand revalidation with cache tags, never a redeploy"* — and this is the
 * one endpoint that can perform it, because `revalidatePath` only works inside this process.
 *
 * ## Why the decision is not here
 *
 * `src/revalidate/catalogue.ts` decides which paths and reports which artefacts; this route parses a body
 * and calls it. The split is what makes the loop testable without a server — the mistake to catch is a
 * forgotten locale or a forgotten `/pricing`, and that is a unit test — while the endpoint remains the
 * only thing that has to run inside Next.
 *
 * ## POST only, and why a GET is a 405 rather than a redirect
 *
 * A crawler issues GETs. If this answered one it would be a cache-invalidation endpoint any crawler could
 * fire on every visit, which is a slow denial of service that looks like a performance problem. It is
 * inside the `(admin)` group, so it is covered by the `/settings` noindex prefix the registry declares and
 * it is exempt from nothing else.
 *
 * **This route is not authenticated**, exactly as the three `/settings` handlers beside it record: there is
 * no admin session until W-SYS-01 ships one, and inventing a bearer token here would be a second
 * authentication scheme for that unit to remove. What it can do is bounded to invalidating a cache: it
 * reads no customer data, writes no row, and returns only the paths it invalidated. It must not be reachable
 * from the internet before W-SYS-01, and the runbook for that unit is where this line comes off.
 */

/** Nothing to prerender: it exists to invalidate what was. */
export const dynamic = 'force-dynamic'

interface RevalidateBody {
  readonly kind?: unknown
  readonly slug?: unknown
  readonly previousSlug?: unknown
}

const isSlug = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(value)

/**
 * The change, parsed, or a message naming what was wrong with it.
 *
 * The slug is validated against the catalogue's own slug shape (`service_slug_kebab_case`, 0017) rather
 * than passed through: `revalidatePath` is handed whatever arrives, and a path with a `?` or a `..` in it
 * would invalidate something else entirely.
 */
function parseChange(body: RevalidateBody): CatalogueChange | string {
  const kind = body.kind
  if (typeof kind !== 'string' || !(CATALOGUE_CHANGE_KINDS as readonly string[]).includes(kind)) {
    return `kind must be one of ${CATALOGUE_CHANGE_KINDS.join(', ')}`
  }
  if (!isSlug(body.slug)) return 'slug must be a catalogue slug: lower-case words joined by hyphens'
  if (body.previousSlug !== undefined && !isSlug(body.previousSlug)) {
    return 'previousSlug, when given, must be a catalogue slug'
  }
  return {
    kind: kind as CatalogueChangeKind,
    slug: body.slug,
    ...(typeof body.previousSlug === 'string' ? { previousSlug: body.previousSlug } : {}),
  }
}

export async function POST(request: Request): Promise<Response> {
  let body: RevalidateBody
  try {
    body = (await request.json()) as RevalidateBody
  } catch {
    return Response.json({ error: 'a JSON body is required' }, { status: 400 })
  }
  const change = parseChange(body)
  if (typeof change === 'string') return Response.json({ error: change }, { status: 400 })

  try {
    const report = await runCatalogueRevalidation(change, { revalidatePath })
    return Response.json(report, { status: 200 })
  } catch (err) {
    // A named refusal from the registry — a route that moved, a param nobody filled — is a 500 with its own
    // message rather than a swallowed failure: the caller is a job, and a job that is told "done" while
    // nothing was invalidated is how a stale price stays published.
    const message = isAppError(err) || err instanceof Error ? err.message : 'revalidation failed'
    return Response.json({ error: message }, { status: 500 })
  }
}

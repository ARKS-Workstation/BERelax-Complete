import { isAppError } from '@berelax/shared'
import { revalidatePath } from 'next/cache'
import {
  CONTENT_CHANGE_KINDS,
  type ContentChangeKind,
  runContentRevalidation,
} from '../../../../../src/revalidate/content.ts'

/**
 * `POST /settings/content/revalidate` — the CMS publish loop's trigger.
 *
 * `/spa`, `/contact`, `/about`, `/faq` and `/journal` are prerendered from the database, so an FAQ entry
 * published in the admin or a telephone number corrected in the premises row does not reach them by itself.
 * docs/09 §5 states the mechanism — *"a change propagates by on-demand revalidation with cache tags, never a
 * redeploy"* — and this is the one place that can perform it, because `revalidatePath` works only inside this
 * process.
 *
 * The decision about *which* paths is in `src/revalidate/content.ts` and is unit-tested without a server, for
 * the reason the catalogue endpoint beside it records: the mistake to catch is a forgotten `/ar`, and an
 * integration test that fetched the paths the report named would fetch the ones that were revalidated.
 *
 * **POST only, and unauthenticated**, exactly as `/settings/catalogue/revalidate` records: a GET would let any
 * crawler invalidate the site's caches on every visit, and there is no admin session until W-SYS-01 ships one.
 * What it can do is bounded to invalidating a cache — it reads no customer data, writes no row, and returns
 * only the paths it invalidated. It must not be reachable from the internet before W-SYS-01.
 */

/** Nothing to prerender: it exists to invalidate what was. */
export const dynamic = 'force-dynamic'

interface RevalidateBody {
  readonly kind?: unknown
}

export async function POST(request: Request): Promise<Response> {
  let body: RevalidateBody
  try {
    body = (await request.json()) as RevalidateBody
  } catch {
    return Response.json({ error: 'a JSON body is required' }, { status: 400 })
  }
  const kind = body.kind
  if (typeof kind !== 'string' || !(CONTENT_CHANGE_KINDS as readonly string[]).includes(kind)) {
    return Response.json(
      { error: `kind must be one of ${CONTENT_CHANGE_KINDS.join(', ')}` },
      { status: 400 },
    )
  }
  try {
    const report = await runContentRevalidation(kind as ContentChangeKind, { revalidatePath })
    return Response.json(report, { status: 200 })
  } catch (err) {
    // A named refusal from the registry — a route that moved, a locale it is not served in — is a 500 with its
    // own message rather than a swallowed failure: the caller is a job, and a job told "done" while nothing
    // was invalidated is how a stale answer stays published.
    const message = isAppError(err) || err instanceof Error ? err.message : 'revalidation failed'
    return Response.json({ error: message }, { status: 500 })
  }
}

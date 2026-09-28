import { handlePublish } from './handler.ts'

/**
 * `POST /api/v1/publication/publish` — the wiring; the guard is next door in `handler.ts`.
 *
 * Under `/api` for the three reasons the media publish endpoint records beside it, each of them a bug
 * avoided: `/api` is exempt from `proxy.ts`'s canonicalisation, so a mistyped spelling is trimmed with a
 * **308** rather than a 301 — and a 301 on a POST is downgraded to a GET with the body dropped, which would
 * turn a refused publish into a silent no-op; a publish is not a document, so a locale would give one
 * endpoint two URLs; and an endpoint under `/api` is somewhere a `curl` naturally goes, which is what makes
 * the SEO agent's 403 an assertion about the endpoint rather than about a screen.
 */
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  return await handlePublish(request)
}

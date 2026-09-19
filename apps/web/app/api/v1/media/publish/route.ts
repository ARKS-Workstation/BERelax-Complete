import { handlePublish } from './handler.ts'

/**
 * `POST /api/v1/media/publish` — the wiring; the guard is next door in `handler.ts`.
 *
 * ## Why this is under `/api` rather than beside the preview
 *
 * Three reasons, and each of them is a bug avoided.
 *
 * `/api` is exempt from `proxy.ts`'s canonicalisation, so a mistyped or trailing-slash spelling is trimmed
 * with a **308** rather than redirected with a 301 — and a 301 on a POST is downgraded to a GET with the
 * body dropped by most clients, which would turn a refused publish into a silent no-op.
 *
 * It is locale-neutral. A publish is not a document; giving it a locale would give one endpoint two URLs.
 *
 * And it is somewhere a `curl` naturally goes. The acceptance criterion asks for two *independent*
 * assertions — the endpoint must refuse a request that did not come from the preview — and an endpoint
 * buried under the page it serves invites exactly the assumption that only that page calls it.
 */
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  return await handlePublish(request)
}

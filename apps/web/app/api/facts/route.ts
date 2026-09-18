import { factsResponse } from '../../../src/facts/handlers.ts'
import { factsRuntime } from '../../../src/facts/runtime.ts'

/**
 * `GET /api/facts` — the canonical machine-readable fact sheet (docs/09 §4, §"LLM SEO").
 *
 * The wiring, and nothing else: the handler is `src/facts/handlers.ts`, which takes its dependencies as an
 * argument so `apps/web/src/facts.itest.ts` can drive it against a real PostgreSQL with a frozen clock.
 * Every fact it publishes comes from the `premises` row and the tables joined to it, so correcting the
 * address in one place corrects this endpoint, the NAP block, the map link and `/llms.txt` together.
 *
 * Outside both locale groups deliberately, for the reason `app/api/v1/otp/route.ts` gives: an endpoint has
 * no document, no direction and no font stack, and putting it inside `(en)` or `(ar)` would give one
 * endpoint two URLs.
 */
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  return await factsResponse(factsRuntime(), request)
}

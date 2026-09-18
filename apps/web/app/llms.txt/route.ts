import { llmsResponse } from '../../src/facts/handlers.ts'
import { factsRuntime } from '../../src/facts/runtime.ts'

/**
 * `GET /llms.txt` — the LLM-SEO index (docs/09 §"LLM SEO").
 *
 * A folder named `llms.txt` holding a `route.ts`, which is how a path whose last segment contains a dot is
 * served by the App Router. It is deliberately not modelled on `app/robots.ts`: Next's metadata conventions
 * cover `robots.txt`, `sitemap.xml` and the icons, and there is no convention for this path because it is
 * not a standard — which is the caveat the served file itself carries.
 *
 * Served as `text/plain`, locale-neutral, and linted against the regulatory profile in force before a byte
 * of it is returned.
 */
export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  return await llmsResponse(factsRuntime())
}

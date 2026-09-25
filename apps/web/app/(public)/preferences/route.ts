import { loadConfig } from '@berelax/config'
import { suppressionKeyNormaliser } from '@berelax/core'
import { createConnection, loadSuppressionPeppers } from '@berelax/db'
import { callerAddress } from '../../api/v1/otp/handler.ts'
import {
  handlePreferenceCentreRead,
  handlePreferenceCentreWrite,
  type PreferenceCentreDeps,
  readPreferenceRequest,
} from './handler.ts'

/**
 * `GET`/`POST /preferences` — the Next binding for the preference centre (C-CRM-07).
 *
 * Everything decidable lives in `./handler.ts`, which `apps/web/src/preference-centre.itest.ts` drives
 * directly; this file is the connection, the pepper, the clock and the two verbs. The same split
 * `/booking/[token]` and `/api/v1/preferences` take, and for the same reason: a route file that held the
 * logic would be a route file that could only be tested through a server.
 *
 * ## Why an UNPARAMETERISED route serving a document
 *
 * The registry entry is a `handler`, `indexable: false`, and there is no `[token]` segment. Three reasons,
 * and the first is the one that decides it:
 *
 *   - **`canonicalPath` lower-cases every path segment and 301s to the result.** C-CRM-04's token is 43
 *     characters of base64url — mixed case — so a token in a path is destroyed by the site's own
 *     canonicalisation, for every customer, every time, with a 404 whose cause is two modules away. B-UI-05
 *     lives with that by minting lower-case hex; this unit cannot, because `optOutTokenShape`'s exactness is
 *     what a property test over a thousand forged and mutated tokens rests on. The query string is carried
 *     across a redirect unchanged, so that is where the capability goes.
 *   - **A registry *document* must declare `sampleParams` and a reciprocal `hreflang` set**, which for a
 *     bearer credential means a live link committed to `apps/web/src/routes/registry.ts` and the token
 *     published in the head of the page. B-UI-05's NOTE argues both at length and both apply here.
 *   - **An unknown token can then be answered with the same status and the same shell as a valid one.**
 *     `/preferences` is a URL that always exists, so a 200 with "this link is not available" is true about
 *     the resource; `/preferences/{token}` for a forged token is not a URL that names anything, and the 404
 *     it would deserve is exactly the oracle the acceptance forbids.
 *
 * ## Why the runtime is built lazily
 *
 * `loadConfig()` throws when `DATABASE_URL` is absent and `loadSuppressionPeppers` throws when
 * `SUPPRESSION_PEPPER` is, and `next build` imports every route module to collect its exports. Building
 * either at module scope would fail the build on any machine without a database or a secret store —
 * including CI, where the build step has no reason to have either. A memoised getter moves the failure to
 * the first request, which is where a missing secret should surface. The pepper is NOT defaulted, and that
 * is the whole of why it exists: keys computed under an empty pepper match nothing, so the page would report
 * a successful unsubscribe and suppress nobody.
 */
export const dynamic = 'force-dynamic'

let runtime: PreferenceCentreDeps | undefined

function preferenceRuntime(): PreferenceCentreDeps {
  if (runtime !== undefined) return runtime
  const config = loadConfig()
  // Small on purpose, for the reason the OTP and manage-booking routes give: PgBouncer multiplexes in front
  // of the database, the managed instance has a hard connection ceiling (ADR 0004), and the integration suite
  // opens a 64-connection pool of its own to prove a row lock.
  const sql = createConnection({ url: config.DATABASE_URL, max: 4 })
  const built: PreferenceCentreDeps = {
    sql,
    now: () => new Date().toISOString(),
    keying: {
      peppers: loadSuppressionPeppers(config),
      // The one normaliser this system has, injected because `packages/db` may not import `packages/core`.
      // There is no fallback: an un-normalised key matches nothing and no constraint can catch it, because
      // the plaintext never reaches a column.
      normalise: suppressionKeyNormaliser,
    },
  }
  runtime = built
  return built
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  return await handlePreferenceCentreRead(
    readPreferenceRequest(url, request.headers, callerAddress),
    preferenceRuntime(),
  )
}

export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url)
  // `formData()` rather than a JSON body: every control on the page is a plain HTML form and works with
  // JavaScript off, which is this unit's first acceptance criterion and the constraint docs/09 §3 puts on
  // the booking flow. The page is opened from a text message on whatever browser the phone has.
  const body = await request.formData()
  const form = new URLSearchParams()
  for (const [key, value] of body.entries()) {
    if (typeof value === 'string') form.append(key, value)
  }
  return await handlePreferenceCentreWrite(
    readPreferenceRequest(url, request.headers, callerAddress),
    form,
    preferenceRuntime(),
  )
}

import { type Kek, parseKek } from '@berelax/clinical'
import { type Config, loadConfig } from '@berelax/config'
import type { Clock, Instant } from '@berelax/core'
import { createConnection, type Sql } from '@berelax/db'
import {
  createPostgresConnectionStore,
  createPostgresRefreshLock,
  type GoogleLogger,
} from '@berelax/google'
import { createCallLog } from '@berelax/providers/call-log'
import { FailureScript } from '@berelax/providers/failure'
import {
  type BusinessProfileProvider,
  createFakeBusinessProfile,
  createFakeGoogleOAuth,
  type GoogleOAuthProvider,
} from '@berelax/providers/google'
import { AppError, isAppError } from '@berelax/shared'
import { adminChromeFor } from '../../../../../src/components/admin/google-reauth-source.ts'
import { type AdminPrincipal, guardAdminRoute } from '../../../../../src/session.ts'
import {
  type GbpSnapshotPrincipal,
  handleGbpSnapshotRead,
  handleGbpSnapshotWrite,
} from './handler.ts'

/**
 * `GET`/`POST /agents/seo/gbp-snapshot` — the Next binding for the consistency check (G-SEO-06).
 *
 * Everything decidable is in `./handler.ts`, which the integration suite drives directly with an
 * injected clock and an injected Google seam; this file is the connection, the session, the clock, the
 * provider wiring and the two verbs. The same split every other admin surface takes, and here for a
 * specific reason: the recorded claim carries an instant a person supplied, and every assertion about
 * which instant reached the audit row is made under a frozen clock — which it cannot be behind a
 * `next start`.
 */
export const dynamic = 'force-dynamic'

/** A connection per request, closed in a `finally`. `max: 2` for the reason every admin route gives. */
async function withSql<T>(run: (sql: Sql) => Promise<T>): Promise<T> {
  const config = loadConfig()
  const sql = createConnection({ url: config.DATABASE_URL, max: 2 })
  try {
    return await run(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/**
 * 503 and `text/plain`. Deliberately NOT a document: every file under `app/(admin)` that emits a
 * doctype has to render the Google re-auth banner (G-CONN-08) and `google-reauth-banner.test.ts` walks
 * the tree to say so.
 */
function unavailable(error: unknown): Response {
  const message = isAppError(error) ? error.message : 'Unexpected'
  return new Response(`The Google profile snapshot is not available: ${message}\n`, {
    status: 503,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Two fields of five: this handler decides on a ROLE and prints the employment handle as its label. */
function snapshotPrincipalFrom(principal: AdminPrincipal): GbpSnapshotPrincipal {
  return { staffReference: principal.staffReference, role: principal.role }
}

/** The wall clock, as every admin route spells it. `@berelax/core` is pure and exports no clock. */
const systemClock: Clock = { now: () => Date.now() as Instant }

/** One structured line per Google call, which is what makes a degraded read explicable afterwards. */
const logger: GoogleLogger = {
  log(line) {
    const payload = JSON.stringify({ surface: 'gbp-snapshot', ...line })
    if (line.level === 'error') console.error(payload)
    else if (line.level === 'warn') console.warn(payload)
    else console.log(payload)
  },
}

/**
 * The key the stored refresh token is sealed with, read from the environment for now.
 *
 * The same deferral the consent route and the picker record, verbatim: nothing in this system loads a
 * KEK at runtime yet, and naming the app-wide key belongs with the secret inventory in H-HARD-03.
 * Refusing loudly is the only safe alternative to inventing a key per process.
 */
function googleTokenKek(): Kek {
  const material = process.env['GOOGLE_TOKEN_KEK']
  const version = process.env['GOOGLE_TOKEN_KEK_VERSION'] ?? 'v1'
  if (!material) {
    throw new AppError(
      'provider_unavailable',
      'GOOGLE_TOKEN_KEK is not set, so the stored Google token cannot be opened and the profile cannot ' +
        'be read. The manual snapshot is the path that still works, and this screen degrades to it.',
    )
  }
  return parseKek(material, version)
}

function providersFor(config: Config): {
  readonly oauth: GoogleOAuthProvider
  readonly profile: BusinessProfileProvider
} {
  if (config.GOOGLE_PROVIDER === 'real') {
    // Deliberately not a silent fallback to the fake: a production deploy that looked connected and
    // talked to nothing is worse than one that refuses. The real adapters need Business Profile API
    // access, granted by application review rather than by enabling an API (docs/10 §1, Y3-gbp-api).
    throw new AppError(
      'provider_unavailable',
      'The real Google adapters are not implemented. Set GOOGLE_PROVIDER=fake to compare against the ' +
        'local stand-in, or record a snapshot by hand — which is what this screen is for.',
    )
  }
  const shared = {
    log: createCallLog(() => new Date().toISOString()),
    failures: new FailureScript(),
    now: () => new Date().toISOString(),
  }
  return { oauth: createFakeGoogleOAuth(shared), profile: createFakeBusinessProfile(shared) }
}

function checkerFor(sql: Sql) {
  const config = loadConfig()
  const providers = providersFor(config)
  const store = createPostgresConnectionStore(sql)
  return {
    google: {
      store,
      lock: createPostgresRefreshLock(sql),
      oauth: providers.oauth,
      kek: googleTokenKek(),
      clock: systemClock,
      logger,
    },
    profile: providers.profile,
  }
}

export async function GET(request: Request): Promise<Response> {
  // W-SYS-11: the session, before anything else this handler does. `guardAdminRoute` never throws and
  // fails closed, so it is safe as the first statement and outside this handler's own `try`.
  const authorised = await guardAdminRoute(request)
  if ('response' in authorised) return authorised.response
  try {
    const url = new URL(request.url)
    return await withSql(async (sql) =>
      handleGbpSnapshotRead(
        {
          searchParams: url.searchParams,
          body: null,
          principal: snapshotPrincipalFrom(authorised.principal),
          chrome: await adminChromeFor({ sql, now: Date.now() as Instant, request }),
        },
        { sql, now: () => new Date(), checker: checkerFor(sql) },
      ),
    )
  } catch (error) {
    return unavailable(error)
  }
}

export async function POST(request: Request): Promise<Response> {
  // W-SYS-11: the session, before anything else this handler does.
  const authorised = await guardAdminRoute(request)
  if ('response' in authorised) return authorised.response
  try {
    const url = new URL(request.url)
    // `application/x-www-form-urlencoded` only. This screen has no JSON client: it is one
    // `<form method="post">`, which is what makes it work with JavaScript off. A body that is not
    // form-encoded parses to an empty `URLSearchParams`, which the handler refuses by name as
    // `unreadable_request` rather than as a 500.
    const body = new URLSearchParams(await request.text())
    return await withSql(async (sql) =>
      handleGbpSnapshotWrite(
        {
          searchParams: url.searchParams,
          body,
          principal: snapshotPrincipalFrom(authorised.principal),
          chrome: await adminChromeFor({ sql, now: Date.now() as Instant, request }),
        },
        { sql, now: () => new Date(), checker: checkerFor(sql) },
      ),
    )
  } catch (error) {
    return unavailable(error)
  }
}

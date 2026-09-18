import { type Kek, parseKek } from '@berelax/clinical'
import { type Config, loadConfig } from '@berelax/config'
import type { Clock, Instant } from '@berelax/core'
import { createConnection, type Sql } from '@berelax/db'
import {
  createPostgresConnectionStore,
  createPostgresRefreshLock,
  enumerateGbpChoices,
  enumerateSearchConsoleChoices,
  type GoogleLogger,
  type PickerDeps,
  type SelectionActor,
  selectGbpLocation,
  selectSearchConsoleProperty,
  type WithGoogleDeps,
} from '@berelax/google'
import { createCallLog } from '@berelax/providers/call-log'
import { FailureScript } from '@berelax/providers/failure'
import {
  type BusinessProfileProvider,
  createFakeBusinessProfile,
  createFakeGoogleOAuth,
  createFakeSearchConsole,
  type GoogleOAuthProvider,
  type SearchConsoleProvider,
} from '@berelax/providers/google'
import { AppError, isAppError } from '@berelax/shared'

/**
 * The account and location picker: what this Google account can serve, and which resource it will.
 *
 * `GET` enumerates — every account, every location under each, deduped by `placeId`, plus the Search
 * Console properties — and says in plain English why the list is empty when it is. `POST` records one
 * choice: a `placeId` selects the Business Profile listing for every GBP capability, a `siteUrl` selects
 * the Search Console property, and **neither selects the other** (docs/10 §2).
 *
 * ## Why this is a route handler and not a page
 *
 * W-SITE-01's registry is in exact bijection with the filesystem and requires every *document* to be served
 * in both locales, which would mean an Arabic admin page and an admin shell to render it — W-SYS-01's work,
 * with the settings card that reads this in G-CONN-07. A handler answering JSON is the same shape the
 * consent route next door already takes, is covered by the `/settings` noindex prefix, and makes the picker
 * walkable today rather than after two other units land.
 *
 * **This route is not authenticated.** There is no admin session until W-SYS-01, exactly as the consent
 * route records, so it must not be deployed to a reachable environment before then: `POST` here chooses
 * which Google listing this business replies as. The actor recorded on the audit row says so rather than
 * inventing a person.
 */
export const dynamic = 'force-dynamic'

/**
 * The actor written onto every `capability_changed` row this route produces.
 *
 * It names the surface and states that the identity is not established, because there is no session to take
 * one from. A plausible-looking user label would be indistinguishable from a real one in the audit log,
 * which is worse than a blank (the brief's rule 15); a bare `system` would be a lie in the other direction,
 * since a human chose.
 */
const PICKER_ACTOR: SelectionActor = {
  kind: 'staff',
  label: 'settings picker (no admin session: W-SYS-01)',
}

const systemClock: Clock = { now: () => Date.now() as Instant }

/**
 * One structured line per Google call, at the level the chokepoint chose.
 *
 * The chokepoint emits the fields a query groups by — correlation id, capability, connection id — and a
 * leak detector in `with-google.test.ts` asserts that nothing reaching them is a secret. So this can print
 * the line as it arrives without filtering it.
 */
const logger: GoogleLogger = {
  log(line) {
    const payload = JSON.stringify({
      message: line.message,
      correlationId: line.correlationId,
      capability: line.capability,
      consumer: line.consumer,
      connectionId: line.connectionId,
      ...line.fields,
    })
    if (line.level === 'error') console.error(payload)
    else if (line.level === 'warn') console.warn(payload)
    else console.log(payload)
  },
}

interface GoogleFakes {
  readonly oauth: GoogleOAuthProvider
  readonly profile: BusinessProfileProvider
  readonly searchConsole: SearchConsoleProvider
}

function providersFor(config: Config): GoogleFakes {
  if (config.GOOGLE_PROVIDER === 'real') {
    // Deliberately not a silent fallback to the fake: a production deploy that looked connected and talked
    // to nothing is worse than one that refuses. The real adapters need Business Profile API access, which
    // is granted by application review rather than by enabling an API (docs/10 §1).
    throw new AppError(
      'provider_unavailable',
      'The real Google adapters are not implemented. Set GOOGLE_PROVIDER=fake to walk the picker against ' +
        'the local stand-in, which serves the Al Zahiyah listing under a LOCATION_GROUP account.',
    )
  }
  // `@berelax/providers/google` rather than the package barrel: the barrel re-exports the SMS and email
  // ports, which `messaging-providers-only-inside-a-transport` forbids outside a transport.
  const shared = {
    log: createCallLog(() => new Date().toISOString()),
    failures: new FailureScript(),
    now: () => new Date().toISOString(),
  }
  return {
    oauth: createFakeGoogleOAuth(shared),
    profile: createFakeBusinessProfile(shared),
    searchConsole: createFakeSearchConsole(shared),
  }
}

/**
 * The key the stored refresh token is sealed with, read from the environment for now.
 *
 * The same deferral the consent route records: nothing in this system loads a KEK at runtime yet, and naming
 * the app-wide key belongs with the secret inventory in H-HARD-03. Refusing loudly is the only safe
 * alternative to inventing a key per process.
 */
function googleTokenKek(): Kek {
  const material = process.env['GOOGLE_TOKEN_KEK']
  const version = process.env['GOOGLE_TOKEN_KEK_VERSION'] ?? 'v1'
  if (!material) {
    throw new AppError(
      'provider_unavailable',
      'GOOGLE_TOKEN_KEK is not set, so the stored Google token cannot be opened and no listing can be ' +
        'read. Nothing was changed.',
    )
  }
  return parseKek(material, version)
}

function pickerDeps(config: Config, sql: Sql): PickerDeps {
  const fakes = providersFor(config)
  const store = createPostgresConnectionStore(sql)
  const google: WithGoogleDeps = {
    store,
    oauth: fakes.oauth,
    kek: googleTokenKek(),
    clock: systemClock,
    // The advisory transaction lock, so an enumeration that has to refresh a token does not race the
    // review poll or the health check (G-CONN-04, docs/10 §4).
    lock: createPostgresRefreshLock(sql),
    logger,
  }
  return {
    google,
    selections: store,
    profile: fakes.profile,
    searchConsole: fakes.searchConsole,
  }
}

function problem(error: unknown): Response {
  // The reason code, never the prose, is what a caller branches on — and the status distinguishes a refused
  // choice (4xx) from a deployment that cannot serve the screen at all (5xx).
  const reason = isAppError(error) ? (error.details['reason'] ?? error.kind) : 'unexpected'
  const status = isAppError(error) && error.kind === 'provider_unavailable' ? 503 : 400
  return Response.json(
    { ok: false, reason, message: isAppError(error) ? error.message : 'Unexpected' },
    { status, headers: { 'cache-control': 'no-store' } },
  )
}

async function withSql<T>(run: (sql: Sql) => Promise<T>): Promise<T> {
  const config = loadConfig()
  const sql = createConnection({ url: config.DATABASE_URL, max: 2 })
  try {
    return await run(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

export async function GET(request: Request): Promise<Response> {
  try {
    const connectionId = new URL(request.url).searchParams.get('connectionId')
    return await withSql(async (sql) => {
      const deps = pickerDeps(loadConfig(), sql)
      // Both halves in one response, because they are two independent selections and the owner needs to see
      // that one of them can be finished while the other waits for Google's approval (docs/10 §9).
      const options = connectionId === null ? {} : { connectionId }
      const [businessProfile, searchConsole] = await Promise.all([
        enumerateGbpChoices(deps, options),
        enumerateSearchConsoleChoices(deps, options),
      ])
      return Response.json(
        { ok: true, businessProfile, searchConsole },
        { headers: { 'cache-control': 'no-store' } },
      )
    })
  } catch (error) {
    return problem(error)
  }
}

interface SelectionRequest {
  readonly connectionId?: unknown
  readonly placeId?: unknown
  readonly siteUrl?: unknown
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json().catch(() => ({}))) as SelectionRequest
    const connectionId = typeof body.connectionId === 'string' ? body.connectionId : null
    const placeId = typeof body.placeId === 'string' ? body.placeId : null
    const siteUrl = typeof body.siteUrl === 'string' ? body.siteUrl : null
    if (connectionId === null) {
      throw new AppError(
        'validation',
        'A selection must name the connection it belongs to. The picker enumerates one Google account and ' +
          'writes the choice back to that same connection — a selection with no connection could be ' +
          'written against another account entirely.',
        { details: { reason: 'google_picker_connection_missing' } },
      )
    }
    if ((placeId === null) === (siteUrl === null)) {
      throw new AppError(
        'validation',
        'Send exactly one of placeId or siteUrl. The Business Profile listing and the Search Console ' +
          'property are separate selections with separate identifiers, and one request that set both would ' +
          'be two decisions recorded as one.',
        { details: { reason: 'google_picker_choice_ambiguous' } },
      )
    }

    return await withSql(async (sql) => {
      const deps = pickerDeps(loadConfig(), sql)
      const selection =
        placeId !== null
          ? await selectGbpLocation(deps, { connectionId, placeId, actor: PICKER_ACTOR })
          : await selectSearchConsoleProperty(deps, {
              connectionId,
              // Non-null by the exclusive-or check above.
              siteUrl: siteUrl ?? '',
              actor: PICKER_ACTOR,
            })
      return Response.json({ ok: true, selection }, { headers: { 'cache-control': 'no-store' } })
    })
  } catch (error) {
    return problem(error)
  }
}

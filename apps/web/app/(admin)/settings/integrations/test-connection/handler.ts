import { type Kek, parseKek } from '@berelax/clinical'
import type { Config } from '@berelax/config'
import type { Clock, Instant } from '@berelax/core'
import { readSetting, type Sql } from '@berelax/db'
import {
  createPostgresConnectionStore,
  createPostgresRefreshLock,
  type GoogleLogger,
  type GooglePublishingStatus,
  type HealthCheckDeps,
  isGooglePublishingStatus,
  type TestConnectionOutcome,
  testConnection,
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
import { AppError } from '@berelax/shared'

/**
 * *Test connection*: the nightly pass, on demand, for one connection.
 *
 * ## The one thing this must not do
 *
 * Report success without having established anything. docs/10 §4 asks for this button precisely because
 * every Google invalidation is silent, so the owner presses it when they already suspect something — and
 * the pass it runs **throws nothing**, by design: it catches what `withGoogle` raises and records it,
 * because the product of a health pass is the record rather than the read. A handler that wrapped the call
 * in a `try` and answered `{ ok: true }` when nothing threw would report success for a connection where no
 * call was made at all.
 *
 * So the verdict comes from `testConnection`, which computes it from evidence — at least one
 * authenticated call answered by Google — and names every failure. This file is wiring and a status code.
 *
 * ## One implementation, shared with the cron
 *
 * `testConnection` runs `TEST_CONNECTION_PASS`, which **is** `runDeepCheck`: the same exported function
 * reference `apps/worker`'s 03:00 handler invokes. Both ends of that identity are asserted, in
 * `packages/google/src/health/test-connection.test.ts` and in
 * `apps/worker/src/jobs/google-connection-health.test.ts`, because `apps/web` may not import `apps/worker`
 * and no single test can see both.
 *
 * ## This route is not authenticated
 *
 * Exactly as the consent route, the picker and the health fragment beside it record: there is no admin
 * session in this application yet — Payload's session is the CMS's, and its user table is not the staff
 * table. That matters more here than for the three GETs next door, because this POST spends a **forced
 * token refresh** against an account limit of about a hundred live refresh tokens. It is the same exposure
 * the picker's enumeration already has, and it must not be deployed to a reachable environment before the
 * session exists. The actor recorded against the run says so rather than inventing a person.
 */

const systemClock: Clock = { now: () => Date.now() as Instant }

/**
 * One structured line per Google call, at the level the chokepoint chose.
 *
 * The chokepoint emits the fields a query groups by and a leak detector in `with-google.test.ts` asserts
 * that nothing reaching them is a secret, so the line is printed as it arrives.
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

/**
 * The provider adapters for a configured mode.
 *
 * `real` throws rather than falling back, and here the reason is at its sharpest: a test button that
 * silently checked a stand-in would report every connection healthy for ever, which is the exact shape of
 * failure this unit exists to remove (ADR 0005, docs/12 §1).
 */
function providersFor(config: Config): GoogleFakes {
  if (config.GOOGLE_PROVIDER === 'real') {
    throw new AppError(
      'provider_unavailable',
      'The real Google adapters are not implemented, so Test connection would be testing a stand-in and ' +
        'reporting it as the connection. Set GOOGLE_PROVIDER=fake until they exist.',
      { details: { reason: 'google_provider_not_implemented' } },
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
 * The key the stored refresh token is sealed with, read from the environment.
 *
 * The same deferral the consent route, the picker and the worker all record: nothing in this system loads
 * a KEK at runtime yet, and naming the app-wide key belongs with the secret inventory in H-HARD-03.
 * Refusing loudly is the only safe alternative to inventing one per process — a test run with the wrong
 * key would report the connection broken and send the owner through a re-consent that fixes nothing.
 */
function googleTokenKek(): Kek {
  const material = process.env['GOOGLE_TOKEN_KEK']
  const version = process.env['GOOGLE_TOKEN_KEK_VERSION'] ?? 'v1'
  if (!material) {
    throw new AppError(
      'provider_unavailable',
      'GOOGLE_TOKEN_KEK is not set, so no stored Google token can be opened and this check cannot tell a ' +
        'dead grant from a missing key. Nothing was tested.',
      { details: { reason: 'google_token_kek_absent' } },
    )
  }
  return parseKek(material, version)
}

/** The publishing status, refused rather than coerced. The same read the card and the cron make. */
async function publishingStatus(sql: Sql): Promise<GooglePublishingStatus> {
  const value = await readSetting(sql, 'google.consent_screen_publishing_status')
  if (!isGooglePublishingStatus(value)) {
    throw new AppError(
      'invariant_violated',
      `google.consent_screen_publishing_status holds ${JSON.stringify(value)}, which is not a ` +
        'publishing status this system understands. Nothing was tested rather than reporting a result ' +
        'that silently assumes there is no seven-day expiry.',
      { details: { reason: 'google_publishing_status_unknown' } },
    )
  }
  return value
}

/** Everything the pass needs, assembled from configuration and the environment. */
export async function testConnectionDeps(sql: Sql, config: Config): Promise<HealthCheckDeps> {
  const fakes = providersFor(config)
  const store = createPostgresConnectionStore(sql)
  const google: WithGoogleDeps = {
    store,
    oauth: fakes.oauth,
    kek: googleTokenKek(),
    clock: systemClock,
    // The advisory transaction lock, so a test pressed while the review poll is running does not race it
    // (G-CONN-04, docs/10 §4).
    lock: createPostgresRefreshLock(sql),
    logger,
  }
  return {
    google,
    health: store,
    profile: fakes.profile,
    searchConsole: fakes.searchConsole,
    publishingStatus: await publishingStatus(sql),
    gbpAccessGranted: (await readSetting(sql, 'google.business_profile_access_granted')) === true,
  }
}

/** Runs the check. Separate from the route so a test can drive it at a frozen clock. */
export async function runTestConnection(args: {
  readonly sql: Sql
  readonly config: Config
  readonly connectionId: string
  readonly now: Instant
}): Promise<TestConnectionOutcome> {
  return await testConnection(
    await testConnectionDeps(args.sql, args.config),
    args.connectionId,
    args.now,
  )
}

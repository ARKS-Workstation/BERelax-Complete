import { generateKek } from '@berelax/clinical'
import {
  fixedClock,
  GOOGLE_SCOPE_BUSINESS_MANAGE,
  GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY,
  type Instant,
  instantFromIso,
} from '@berelax/core'
import { createCallLog } from '@berelax/providers/call-log'
import { FailureScript } from '@berelax/providers/failure'
import {
  AL_ZAHIYAH_LOCATION,
  createFakeBusinessProfile,
  createFakeGoogleOAuth,
  createFakeSearchConsole,
  GBP_LOCATION_GROUP_ACCOUNT,
  SEARCH_CONSOLE_SITE_FIXTURES,
} from '@berelax/providers/google'
import { beforeEach, describe, expect, it } from 'vitest'
import { oneLineAddress } from '../adapters/business-information.ts'
import { connectionRecord, createMemoryConnectionStore } from '../memory-store.ts'
import { createMemoryRefreshLock } from '../token-refresh.ts'
import { connectionBinding, sealToken } from '../token-store.ts'
import { type WithGoogleDeps, withGoogle } from '../with-google.ts'
import {
  HEALTH_NO_CONFIRMED_LISTING,
  HEALTH_NO_CONSUMER,
  HEALTH_SCOPE_MISSING,
  type HealthCheckDeps,
  runDeepCheck,
} from './deep-check.ts'

/**
 * The daily pass, driven against the fakes and the memory store.
 *
 * What this file is for, and what it deliberately leaves to `google-health.itest.ts`: every claim here is
 * about the *decisions* the pass makes — which capability gets which health, what the scope diff touches,
 * whether a forced refresh actually happens. The claims about rows the owner can see, the mirrored audit
 * trail and the heartbeat need a real database and live next door.
 *
 * Every assertion is paired with the case that must come out differently. The scope-diff test has a
 * control asserting the *other* capabilities were untouched, and the forced-refresh test has one asserting
 * that the same run without the flag makes no refresh request at all — without it, "the fake saw one
 * refresh" is satisfied by a fake that refreshes on every call.
 */

const KEK = generateKek('v1')
const NOW_ISO = '2026-09-25T03:00:00.000Z'
const NOW = instantFromIso(NOW_ISO)
const CONSENT = instantFromIso('2026-09-20T10:00:00.000Z')
const CONNECTION_ID = '01920000-0000-7000-8000-0000000000aa'
const SUB = 'sub-deep-check-unit'
const REFRESH_TOKEN = '1//09-FIXTURE-deep-check-refresh-token'
const BOTH_SCOPES = [GOOGLE_SCOPE_BUSINESS_MANAGE, GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY]

const GBP_REF = {
  account: GBP_LOCATION_GROUP_ACCOUNT.name,
  location: AL_ZAHIYAH_LOCATION.name,
  placeId: AL_ZAHIYAH_LOCATION.metadata.placeId,
}
const GSC_REF = { siteUrl: SEARCH_CONSOLE_SITE_FIXTURES[0]?.siteUrl ?? '' }
const CONFIRMED_ADDRESS = oneLineAddress(AL_ZAHIYAH_LOCATION.storefrontAddress)

const binding = connectionBinding({ connectionId: CONNECTION_ID, googleSub: SUB })

interface Harness {
  readonly deps: HealthCheckDeps
  readonly store: ReturnType<typeof createMemoryConnectionStore>
  readonly refreshes: () => number
}

/**
 * A connection with all four capability rows, as a consent plus a selection would leave it.
 *
 * The confirmed-listing event is written through the store's own `appendEvent`, which is where the picker
 * writes it too — so this fixture exercises the same read path production uses rather than a second one
 * that happens to agree.
 */
function harness(
  options: {
    readonly grantedScopes?: readonly string[]
    readonly apiFailures?: FailureScript
    readonly locations?: Readonly<Record<string, readonly (typeof AL_ZAHIYAH_LOCATION)[]>>
    readonly voiceOfMerchant?: { hasVoiceOfMerchant: boolean; hasBusinessAuthority: boolean }
    readonly confirmedTitle?: string
    readonly confirmedAddress?: string
    readonly accessExpiresAt?: Instant | null
    readonly publishingStatus?: 'testing' | 'production'
    readonly gbpAccessGranted?: boolean
  } = {},
): Harness {
  const grantedScopes = options.grantedScopes ?? BOTH_SCOPES
  const store = createMemoryConnectionStore([
    connectionRecord({
      id: CONNECTION_ID,
      googleSub: SUB,
      grantedScopes,
      refreshToken: sealToken(KEK, binding, REFRESH_TOKEN),
      consentAt: CONSENT,
      ...(options.accessExpiresAt === undefined
        ? {}
        : {
            accessToken: sealToken(KEK, binding, 'fake-access-cached'),
            accessExpiresAt: options.accessExpiresAt,
          }),
    }),
  ])
  for (const capability of ['gbp_reviews', 'gbp_location', 'gbp_performance', 'gsc'] as const) {
    store.putCapability({
      connectionId: CONNECTION_ID,
      capability,
      resourceRef: capability === 'gsc' ? GSC_REF : GBP_REF,
      health: 'unknown',
      isPrimary: true,
    })
  }
  // The owner-confirmed snapshot, exactly as the picker records it.
  void store.appendEvent({
    connectionId: CONNECTION_ID,
    googleSub: null,
    event: 'capability_changed',
    actorKind: 'staff',
    actorLabel: 'settings picker',
    detail: {
      capability: 'gbp_location',
      source: 'picker',
      placeId: GBP_REF.placeId,
      title: options.confirmedTitle ?? AL_ZAHIYAH_LOCATION.title,
      address: options.confirmedAddress ?? CONFIRMED_ADDRESS,
    },
  })

  const log = createCallLog(() => NOW_ISO)
  const api = options.apiFailures ?? new FailureScript()
  const oauthFailures = new FailureScript()
  const profile = createFakeBusinessProfile({
    log,
    failures: api,
    now: () => NOW_ISO,
    ...(options.locations === undefined ? {} : { locationsByAccount: options.locations }),
    ...(options.voiceOfMerchant === undefined ? {} : { voiceOfMerchant: options.voiceOfMerchant }),
  })
  const searchConsole = createFakeSearchConsole({ log, failures: api, now: () => NOW_ISO })
  const google: WithGoogleDeps = {
    store,
    oauth: createFakeGoogleOAuth({ log, failures: oauthFailures, now: () => NOW_ISO, sub: SUB }),
    kek: KEK,
    clock: fixedClock(NOW_ISO),
    lock: createMemoryRefreshLock(store),
    logger: { log: () => {} },
  }
  return {
    store,
    refreshes: () =>
      log.all().filter((entry) => entry.operation === 'refresh' && entry.outcome === 'success')
        .length,
    deps: {
      google,
      health: store,
      profile,
      searchConsole,
      publishingStatus: options.publishingStatus ?? 'testing',
      gbpAccessGranted: options.gbpAccessGranted ?? true,
    },
  }
}

const healthOf = async (
  store: ReturnType<typeof createMemoryConnectionStore>,
  capability: string,
): Promise<string | undefined> =>
  (await store.capabilitiesFor(CONNECTION_ID)).find((row) => row.capability === capability)?.health

describe('acceptance — one cheap read per capability, and only a read may write ok', () => {
  it('writes ok for every declared capability it managed to read', async () => {
    const { deps, store } = harness()
    const result = await runDeepCheck(deps, NOW)
    expect(result.connections).toHaveLength(1)
    expect(await healthOf(store, 'gbp_reviews')).toBe('ok')
    expect(await healthOf(store, 'gbp_location')).toBe('ok')
    expect(await healthOf(store, 'gsc')).toBe('ok')
  })

  it('leaves the capability no consumer declares alone, and says why', async () => {
    // `gbp_performance` is registered by every consent and has no consumer and no client at all — docs/10
    // §7 cannot even resolve its hostname. Its health stays `unknown` and the run records the reason, so
    // the gap is visible rather than looking like a capability that failed.
    const { deps, store } = harness()
    const result = await runDeepCheck(deps, NOW)
    expect(await healthOf(store, 'gbp_performance')).toBe('unknown')
    const performance = result.connections[0]?.capabilities.find(
      (c) => c.capability === 'gbp_performance',
    )
    expect(performance?.called).toBe(false)
    expect(performance?.reason).toBe(HEALTH_NO_CONSUMER)
  })

  it('derives healthy even though gbp_performance is unknown', async () => {
    // The consequence of the line above, and the reason the derivation is scoped to declared
    // capabilities: without that, every connection in the system would read amber for ever, and a badge
    // that is always on is a badge nobody looks at.
    const { deps } = harness({ publishingStatus: 'production' })
    const result = await runDeepCheck(deps, NOW)
    expect(result.connections[0]?.health.displayState).toBe('healthy')
    expect(result.connections[0]?.event).toBe('health_check_ok')
  })
})

describe('acceptance — per-capability health with different outcomes', () => {
  it('marks gbp_reviews quota_zero and leaves gsc ok, and sets the connection degraded', async () => {
    // The Business Profile reads fail and Search Console succeeds, which needs two failure scripts rather
    // than one: a single script armed `failAlways` would take down `sites.list` too, and the assertion
    // that matters is precisely that the two capabilities came out differently.
    const { deps, store } = harness()
    const log = createCallLog(() => NOW_ISO)
    const profileFailures = new FailureScript().failAlways('access_not_granted')
    const failingProfile = createFakeBusinessProfile({
      log,
      failures: profileFailures,
      now: () => NOW_ISO,
    })
    const result = await runDeepCheck({ ...deps, profile: failingProfile }, NOW)

    expect(await healthOf(store, 'gbp_reviews')).toBe('quota_zero')
    expect(await healthOf(store, 'gsc')).toBe('ok')
    // Two rows, two different outcomes, on one connection — which is the whole reason health is
    // per-capability rather than per-connection.
    expect(new Set([await healthOf(store, 'gbp_reviews'), await healthOf(store, 'gsc')]).size).toBe(
      2,
    )
    expect(result.connections[0]?.health.displayState).toBe('degraded')
    // And NOT a total failure: something reached Google, so `last_ok_at` moved.
    expect(result.connections[0]?.totalFailure).toBe(false)
    const stored = await store.load(CONNECTION_ID)
    expect(stored?.lastOkAt).toBe(NOW)
  })

  it('reports the same refusal as pending approval while access is unapproved', async () => {
    // The control for the line above, and it is the launch-day normal rather than an edge case: while the
    // Basic API Access application is pending, quota sits at 0 QPM and every GBP call fails however valid
    // the token is. Rendering that as `degraded` would put a red banner on every admin page for six
    // weeks, after which nobody reads red banners.
    const { deps } = harness({ gbpAccessGranted: false })
    const log = createCallLog(() => NOW_ISO)
    const failingProfile = createFakeBusinessProfile({
      log,
      failures: new FailureScript().failAlways('access_not_granted'),
      now: () => NOW_ISO,
    })
    const result = await runDeepCheck({ ...deps, profile: failingProfile }, NOW)
    expect(result.connections[0]?.health.displayState).toBe('pending_gbp_approval')
  })
})

describe('acceptance — the scope diff is scoped to the capability whose scope is missing', () => {
  it('marks only gsc permission_missing and does not break the connection', async () => {
    const { deps, store } = harness({ grantedScopes: [GOOGLE_SCOPE_BUSINESS_MANAGE] })
    const result = await runDeepCheck(deps, NOW)

    expect(await healthOf(store, 'gsc')).toBe('permission_missing')
    // The control. Every other capability is untouched by the diff, which is what "scoped correctly"
    // means — and the connection itself is still active, because a missing scope is not a dead grant.
    expect(await healthOf(store, 'gbp_reviews')).toBe('ok')
    expect(await healthOf(store, 'gbp_location')).toBe('ok')
    expect(result.connections[0]?.health.displayState).not.toBe('broken')
    expect((await store.load(CONNECTION_ID))?.status).toBe('active')

    const gsc = result.connections[0]?.capabilities.find((c) => c.capability === 'gsc')
    expect(gsc?.called).toBe(false)
    expect(gsc?.reason).toBe(HEALTH_SCOPE_MISSING)
  })
})

describe('acceptance — listing drift', () => {
  it('produces exactly one finding quoting the stored and the returned value', async () => {
    const { deps } = harness({ confirmedTitle: 'BE RELAX — Massage Center and Spa (old name)' })
    const result = await runDeepCheck(deps, NOW)
    const findings = result.connections[0]?.findings ?? []
    expect(findings).toHaveLength(1)
    const finding = findings[0]
    expect(finding?.kind).toBe('listing_drift')
    if (finding?.kind !== 'listing_drift') return
    expect(finding.drifted).toEqual([
      {
        field: 'title',
        stored: 'BE RELAX — Massage Center and Spa (old name)',
        returned: AL_ZAHIYAH_LOCATION.title,
      },
    ])
  })

  it('produces zero findings when the listing is the one the owner confirmed', async () => {
    const { deps } = harness()
    const result = await runDeepCheck(deps, NOW)
    expect(result.connections[0]?.findings).toEqual([])
    expect(result.connections[0]?.event).toBe('health_check_ok')
  })

  it('does not move the capability health, because the listing still works', async () => {
    const { deps, store } = harness({ confirmedAddress: '1 Somewhere Else, Abu Dhabi' })
    const result = await runDeepCheck(deps, NOW)
    expect(result.connections[0]?.findings).toHaveLength(1)
    expect(await healthOf(store, 'gbp_location')).toBe('ok')
    // The row the owner reads, though: a finding is a `health_check_failed` event, not a silent verdict.
    expect(result.connections[0]?.event).toBe('health_check_failed')
  })

  it('reports nothing when no selection was ever recorded, rather than comparing with itself', async () => {
    // A connection with no `capability_changed` row has no owner-confirmed snapshot, and the only values
    // available to compare against would be the ones this read returned. Zero findings AND a recorded
    // reason, so the absence is visible rather than indistinguishable from agreement (ADR 0003).
    const { deps } = harness()
    const fresh = createMemoryConnectionStore([
      connectionRecord({
        id: CONNECTION_ID,
        googleSub: SUB,
        grantedScopes: BOTH_SCOPES,
        refreshToken: sealToken(KEK, binding, REFRESH_TOKEN),
        consentAt: CONSENT,
      }),
    ])
    fresh.putCapability({
      connectionId: CONNECTION_ID,
      capability: 'gbp_location',
      resourceRef: GBP_REF,
      health: 'unknown',
      isPrimary: true,
    })
    const result = await runDeepCheck(
      { ...deps, health: fresh, google: { ...deps.google, store: fresh } },
      NOW,
    )
    expect(result.connections[0]?.findings).toEqual([])
    expect(
      result.connections[0]?.capabilities.find((c) => c.capability === 'gbp_location')?.reason,
    ).toBe(HEALTH_NO_CONFIRMED_LISTING)
  })
})

describe('acceptance — Voice of Merchant', () => {
  it('marks the capability not_verified and records a finding', async () => {
    const { deps, store } = harness({
      voiceOfMerchant: { hasVoiceOfMerchant: false, hasBusinessAuthority: true },
    })
    const result = await runDeepCheck(deps, NOW)
    expect(await healthOf(store, 'gbp_location')).toBe('not_verified')
    expect(result.connections[0]?.findings.map((f) => f.kind)).toEqual(['listing_not_verified'])
    // The read SUCCEEDED, which is the point of reading it at all: an unverified listing answers every
    // read perfectly and refuses every reply, so nothing else in the system could tell.
    const location = result.connections[0]?.capabilities.find(
      (c) => c.capability === 'gbp_location',
    )
    expect(location?.reachedGoogle).toBe(true)
  })
})

describe('acceptance — the refresh is forced, and the control proves it', () => {
  let cachedFor: Instant

  beforeEach(() => {
    // Fifty minutes of life left: far outside the five-minute margin, so nothing would refresh on its own.
    cachedFor = (NOW + 50 * 60 * 1000) as Instant
  })

  it('asks Google for a token even though the cached one is good', async () => {
    const { deps, refreshes } = harness({ accessExpiresAt: cachedFor })
    await runDeepCheck(deps, NOW)
    // At least one: the pass makes three reads and the first forces the refresh, after which the stored
    // token is fresh again. The claim is that a refresh happened at all — which is the only way the
    // seven-day expiry and the six-months-unused invalidation are observable.
    expect(refreshes()).toBeGreaterThanOrEqual(1)
  })

  it('makes NO refresh request when the flag is absent', async () => {
    // The control. Without it, "the fake saw a refresh" is satisfied by a fake that refreshes on every
    // call and the forced path would be untested. The liveness probe is the caller that does not force.
    const { deps, refreshes } = harness({ accessExpiresAt: cachedFor })
    const outcome = await withGoogle(deps.google, 'gsc', async () => 'read', {
      connectionId: CONNECTION_ID,
    })
    expect(outcome.kind).toBe('ok')
    expect(refreshes()).toBe(0)
  })
})

describe('acceptance — a total failure is a row, not a silence', () => {
  it('records health_check_failed for a connection where nothing reached Google', async () => {
    const { deps, store } = harness({ apiFailures: new FailureScript().failAlways('timeout') })
    const result = await runDeepCheck(deps, NOW)
    expect(result.connections[0]?.totalFailure).toBe(true)
    // A timeout is a class `withGoogle` THROWS rather than degrades, and the pass caught it: every
    // capability was still visited, the summary row was still written, and the retry decision travels
    // separately. Letting it propagate would have left the owner's evidence for the night in
    // `pgboss.job`, which docs/10 §4 says is no evidence at all.
    expect(result.retryWorthwhile).toBe(true)
    expect(result.connections[0]?.event).toBe('health_check_failed')
    // `last_checked_at` moved, and the pass itself contributed no `last_ok_at`. The stored value DID move
    // — because the forced refresh succeeded, and a refresh is an authenticated call Google answered. That
    // is the honest reading and it is worth stating: the grant is alive and every API read failed, which
    // are different facts needing different actions. The pass's own write is `lastOkAt: null` and the SQL
    // coalesces, so a failed pass can never clear a real success either.
    const stored = await store.load(CONNECTION_ID)
    expect(stored?.lastCheckedAt).toBe(NOW)
    expect(result.connections[0]?.capabilities.every((c) => !c.reachedGoogle)).toBe(true)
    // And a transient failure is evidence of nothing about the capability: the stored health survives
    // rather than an amber badge appearing because a network blipped.
    expect(await healthOf(store, 'gsc')).toBe('unknown')
  })

  it('does not call a connection with no calls a total failure', async () => {
    // The guard. A connection whose every scope is missing makes no calls at all, and reporting that as a
    // total outage would claim an observation the pass never made.
    const { deps } = harness({ grantedScopes: [] })
    const result = await runDeepCheck(deps, NOW)
    expect(result.connections[0]?.capabilities.every((c) => !c.called)).toBe(true)
    expect(result.connections[0]?.totalFailure).toBe(false)
    expect(result.retryWorthwhile).toBe(false)
  })

  it('does not ask for a retry when something succeeded, however badly the rest went', async () => {
    // The control on the retry decision. Retrying a whole pass because one capability got a 500 would
    // spend three more FORCED refreshes to re-learn what is already recorded — and a forced refresh is the
    // request Google may answer with a rotated token.
    const log = createCallLog(() => NOW_ISO)
    const { deps } = harness()
    const failingProfile = createFakeBusinessProfile({
      log,
      failures: new FailureScript().failAlways('server_error'),
      now: () => NOW_ISO,
    })
    const result = await runDeepCheck({ ...deps, profile: failingProfile }, NOW)
    expect(result.connections[0]?.totalFailure).toBe(false)
    expect(result.retryWorthwhile).toBe(false)
  })
})

describe('acceptance — the tripwire travels on the row the panel renders', () => {
  it('carries the expiry date and the hours remaining in the event detail', async () => {
    const { deps, store } = harness()
    await runDeepCheck(deps, NOW)
    const summary = store
      .events()
      .filter((event) => event.detail?.['source'] === 'google-connection-health')
      .at(-1)
    expect(summary?.detail?.['testingExpiresAt']).toBe('2026-09-27')
    expect(summary?.detail?.['hoursUntilTestingExpiry']).toBe(55)
  })

  it('carries null for a published consent screen', async () => {
    const { deps, store } = harness({ publishingStatus: 'production' })
    await runDeepCheck(deps, NOW)
    const summary = store
      .events()
      .filter((event) => event.detail?.['source'] === 'google-connection-health')
      .at(-1)
    expect(summary?.detail?.['testingExpiresAt']).toBeNull()
    expect(summary?.detail?.['hoursUntilTestingExpiry']).toBeNull()
  })
})

describe('a disconnected connection is not probed', () => {
  it('skips it entirely rather than reporting a fault nobody wants fixed', async () => {
    const { deps, store } = harness()
    await store.recordStatus({
      connectionId: CONNECTION_ID,
      status: 'disconnected',
      statusReason: 'manual',
      lastCheckedAt: NOW,
    })
    const result = await runDeepCheck(deps, NOW)
    expect(result.connections).toEqual([])
  })
})

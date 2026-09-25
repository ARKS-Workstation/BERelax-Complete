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
import { describe, expect, it } from 'vitest'
import { oneLineAddress } from '../adapters/business-information.ts'
import { connectionRecord, createMemoryConnectionStore } from '../memory-store.ts'
import { createMemoryRefreshLock } from '../token-refresh.ts'
import { connectionBinding, sealToken } from '../token-store.ts'
import { type WithGoogleDeps, withGoogle } from '../with-google.ts'
import { type HealthCheckDeps, runDeepCheck } from './deep-check.ts'
import { TEST_CONNECTION_PASS, testConnection } from './test-connection.ts'

/**
 * G-CONN-07 — *Test connection*, and the one thing it must never be able to do.
 *
 * ## The claim this file exists for
 *
 * **A stand-in must never look like it worked** (ADR 0005, docs/12 §1). The button's whole value is that
 * the owner presses it when they already suspect something, so a version that reported success because
 * nothing threw would be worse than no button — and reporting success is exactly what the obvious
 * implementation does, because the pass it runs **throws nothing**. It catches the classes `withGoogle`
 * raises and records them, on purpose: the product of a health pass is the record rather than the read.
 *
 * So every failure case below asserts the reason **by name**, and each is paired with the control that
 * must come out differently — the same harness with the failure disarmed, reporting `ok` with a call that
 * reached Google. Without the control, "a broken provider reports failure" is satisfied by an
 * implementation that reports failure always.
 *
 * ## And the claim about drift
 *
 * `TEST_CONNECTION_PASS` is asserted to BE `runDeepCheck` — the same exported reference
 * `apps/worker/src/jobs/google-connection-health.ts` invokes, where the other end of the identity is
 * asserted against `SCHEDULED_DEEP_CHECK`. Two halves rather than one, because neither package can see
 * both the route and the cron: `apps/web` may not import `apps/worker`, which is what
 * `pnpm boundaries` is for.
 */

const KEK = generateKek('v1')
const NOW_ISO = '2026-09-25T03:00:00.000Z'
const NOW = instantFromIso(NOW_ISO)
const CONSENT = instantFromIso('2026-09-20T10:00:00.000Z')
const CONNECTION_ID = '01920000-0000-7000-8000-0000000000c7'
const SUB = 'sub-test-connection-unit'
const REFRESH_TOKEN = '1//09-FIXTURE-test-connection-refresh-token'
const BOTH_SCOPES = [GOOGLE_SCOPE_BUSINESS_MANAGE, GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY]

const GBP_REF = {
  account: GBP_LOCATION_GROUP_ACCOUNT.name,
  location: AL_ZAHIYAH_LOCATION.name,
  placeId: AL_ZAHIYAH_LOCATION.metadata.placeId,
}
const GSC_REF = { siteUrl: SEARCH_CONSOLE_SITE_FIXTURES[0]?.siteUrl ?? '' }
const binding = connectionBinding({ connectionId: CONNECTION_ID, googleSub: SUB })

interface Harness {
  readonly deps: HealthCheckDeps
  readonly store: ReturnType<typeof createMemoryConnectionStore>
}

/**
 * A connection as a consent plus a selection would leave it, with the same fixtures the daily pass uses.
 *
 * `selectResources: false` is how the *nothing was checked* case is built: a grant with no resource chosen
 * for any capability, which is the state between a consent and a visit to the picker. It is a real state
 * and it is the one a green tick would hide most completely.
 */
function harness(
  options: {
    readonly grantedScopes?: readonly string[]
    readonly apiFailures?: FailureScript
    readonly oauthFailures?: FailureScript
    readonly selectResources?: boolean
    readonly status?: 'active' | 'needs_reauth' | 'disconnected'
    readonly gbpAccessGranted?: boolean
    readonly publishingStatus?: 'testing' | 'production'
    readonly consentAt?: Instant
  } = {},
): Harness {
  const store = createMemoryConnectionStore([
    connectionRecord({
      id: CONNECTION_ID,
      googleSub: SUB,
      grantedScopes: options.grantedScopes ?? BOTH_SCOPES,
      refreshToken: sealToken(KEK, binding, REFRESH_TOKEN),
      consentAt: options.consentAt ?? CONSENT,
      ...(options.status === undefined ? {} : { status: options.status }),
    }),
  ])
  if (options.selectResources !== false) {
    for (const capability of ['gbp_reviews', 'gbp_location', 'gbp_performance', 'gsc'] as const) {
      store.putCapability({
        connectionId: CONNECTION_ID,
        capability,
        resourceRef: capability === 'gsc' ? GSC_REF : GBP_REF,
        health: 'unknown',
        isPrimary: true,
      })
    }
    // The owner-confirmed snapshot, exactly as the picker records it, so listing drift can be absent for
    // the right reason rather than because no snapshot existed to compare against.
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
        title: AL_ZAHIYAH_LOCATION.title,
        address: oneLineAddress(AL_ZAHIYAH_LOCATION.storefrontAddress),
      },
    })
  }

  const log = createCallLog(() => NOW_ISO)
  const api = options.apiFailures ?? new FailureScript()
  const google: WithGoogleDeps = {
    store,
    oauth: createFakeGoogleOAuth({
      log,
      failures: options.oauthFailures ?? new FailureScript(),
      now: () => NOW_ISO,
      sub: SUB,
    }),
    kek: KEK,
    clock: fixedClock(NOW_ISO),
    lock: createMemoryRefreshLock(store),
    logger: { log: () => {} },
  }
  return {
    store,
    deps: {
      google,
      health: store,
      profile: createFakeBusinessProfile({ log, failures: api, now: () => NOW_ISO }),
      searchConsole: createFakeSearchConsole({ log, failures: api, now: () => NOW_ISO }),
      publishingStatus: options.publishingStatus ?? 'production',
      gbpAccessGranted: options.gbpAccessGranted ?? true,
    },
  }
}

describe('acceptance — one implementation, shared with the cron', () => {
  it('is the same exported function reference the scheduled pass invokes', () => {
    expect(TEST_CONNECTION_PASS).toBe(runDeepCheck)
  })

  it('and a second implementation of the same shape is not that reference', () => {
    // The control. `toBe` on a function is only worth something if a different function fails it, which is
    // what a hand-rolled "just for the button" pass would be.
    const lookalike: typeof runDeepCheck = async (_deps, now) => ({
      checkedAt: now,
      connections: [],
      retryWorthwhile: false,
    })
    expect(lookalike).not.toBe(TEST_CONNECTION_PASS)
    expect(withGoogle).not.toBe(TEST_CONNECTION_PASS)
  })

  it('produces the same per-connection result as the cron does for that connection', () => {
    // Reference identity proves the button calls the pass. This proves the pass over one connection is the
    // pass over all of them: two identically seeded harnesses, one driven through the button and one
    // through the nightly entry point, compared on everything the owner is shown.
    return (async () => {
      const viaButton = await testConnection(harness().deps, CONNECTION_ID, NOW)
      const viaCron = await runDeepCheck(harness().deps, NOW)
      const check = viaCron.connections[0]
      expect(check).toBeDefined()
      expect(viaButton.state).toBe('healthy')
      expect(viaButton.capabilities).toEqual(
        check?.capabilities.map((capability) => ({
          capability: capability.capability,
          health: capability.health,
          called: capability.called,
          reachedGoogle: capability.reachedGoogle,
          reason: capability.reason,
        })),
      )
      // The control on the comparison: a harness with a different setting produces a different answer, so
      // the equality above is not satisfied by two empty lists.
      const different = await runDeepCheck(
        harness({
          gbpAccessGranted: false,
          apiFailures: new FailureScript().failAlways('access_not_granted'),
        }).deps,
        NOW,
      )
      expect(different.connections[0]?.capabilities).not.toEqual(check?.capabilities)
    })()
  })
})

describe('acceptance — a broken provider reports failure by name', () => {
  it('reports no_call_reached_google when every read is refused', async () => {
    const { deps } = harness({ apiFailures: new FailureScript().failAlways('server_error') })
    const outcome = await testConnection(deps, CONNECTION_ID, NOW)

    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe('no_call_reached_google')
    // Calls WERE made — which is what distinguishes this from `nothing_was_checked`, and the pair is the
    // whole reason the two reasons exist.
    expect(outcome.called).toBeGreaterThan(0)
    expect(outcome.reachedGoogle).toBe(0)
  })

  it('reports grant_needs_reauth when the refresh comes back invalid_grant', async () => {
    // The day-seven Testing expiry, and every other revocation: the one failure that kills a grant.
    const { deps, store } = harness({
      oauthFailures: new FailureScript().failAlways('invalid_grant'),
    })
    const outcome = await testConnection(deps, CONNECTION_ID, NOW)

    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe('grant_needs_reauth')
    expect(outcome.state).toBe('broken')
    // And the evidence is committed rather than rolled back with the failure — the defect G-CONN-06 fixed.
    expect((await store.load(CONNECTION_ID))?.status).toBe('needs_reauth')
  })

  it('reports capability_failing when one capability is refused and others work', async () => {
    const log = createCallLog(() => NOW_ISO)
    const { deps } = harness()
    const outcome = await testConnection(
      {
        ...deps,
        // Only the Business Profile reads fail. A single shared script would take `sites.list` down with
        // them, and then "one capability failed" would be indistinguishable from a total outage.
        profile: createFakeBusinessProfile({
          log,
          failures: new FailureScript().failAlways('not_verified'),
          now: () => NOW_ISO,
        }),
      },
      CONNECTION_ID,
      NOW,
    )

    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe('capability_failing')
    expect(outcome.state).toBe('degraded')
    // Something still reached Google, so this is not a total failure — the distinction an operator needs.
    expect(outcome.reachedGoogle).toBeGreaterThan(0)
  })

  it('reports nothing_was_checked when the pass had nothing to ask', async () => {
    // The case the obvious implementation gets wrong: a grant with no resource selected for any
    // capability makes NO authenticated call, and nothing throws. A button that wrapped the pass in a
    // try/catch would report success here.
    const { deps } = harness({ selectResources: false })
    const outcome = await testConnection(deps, CONNECTION_ID, NOW)

    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe('nothing_was_checked')
    expect(outcome.called).toBe(0)
    expect(outcome.reachedGoogle).toBe(0)
  })

  it('reports connection_not_found for an id nothing holds', async () => {
    const { deps } = harness()
    const outcome = await testConnection(deps, '01920000-0000-7000-8000-00000000ffff', NOW)
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe('connection_not_found')
  })

  it('reports connection_disconnected rather than pretending nothing was checked', async () => {
    // `runDeepCheck` skips a disconnected connection on purpose, so the narrowed pass returns nothing. The
    // button has to tell the two empty results apart, or offboarding a connection would read as a fault.
    const { deps } = harness({ status: 'disconnected' })
    const outcome = await testConnection(deps, CONNECTION_ID, NOW)
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe('connection_disconnected')
  })

  it('never reports ok with a reason, or a reason with ok', async () => {
    // The invariant across every case above, asserted once: `reason === null` exactly when `ok`.
    for (const options of [
      {},
      { apiFailures: new FailureScript().failAlways('server_error') },
      { oauthFailures: new FailureScript().failAlways('invalid_grant') },
      { selectResources: false },
      { status: 'disconnected' as const },
    ]) {
      const outcome = await testConnection(harness(options).deps, CONNECTION_ID, NOW)
      expect(outcome.ok, JSON.stringify(Object.keys(options))).toBe(outcome.reason === null)
    }
  })
})

describe('acceptance — the success path is reachable, and says what it proved', () => {
  it('reports ok only with a call that Google answered', async () => {
    // The control every failure above needs. Without it, a button hard-coded to fail passes this file.
    const { deps } = harness()
    const outcome = await testConnection(deps, CONNECTION_ID, NOW)

    expect(outcome.ok).toBe(true)
    expect(outcome.reason).toBeNull()
    expect(outcome.state).toBe('healthy')
    expect(outcome.reachedGoogle).toBeGreaterThan(0)
    expect(outcome.called).toBe(outcome.reachedGoogle)
    expect(outcome.findings).toBe(0)
    expect(outcome.checkedAt).toBe(NOW)
    // Every declared capability that was asked came back working. `gbp_performance` is not among them: no
    // consumer declares it and no client exists, so the pass does not ask.
    expect(
      outcome.capabilities
        .filter((c) => c.called)
        .map((c) => c.capability)
        .sort(),
    ).toEqual(['gbp_location', 'gbp_reviews', 'gsc'])
  })

  it('writes ok onto the capability rows, so the card reads what the button proved', async () => {
    const { deps, store } = harness()
    await testConnection(deps, CONNECTION_ID, NOW)
    const rows = await store.capabilitiesFor(CONNECTION_ID)
    expect(
      rows
        .filter((row) => row.health === 'ok')
        .map((row) => row.capability)
        .sort(),
    ).toEqual(['gbp_location', 'gbp_reviews', 'gsc'])
    // And `last_ok_at` moved, which is what stops the card saying Connected with no recency.
    expect((await store.load(CONNECTION_ID))?.lastOkAt).toBe(NOW)
  })

  it('treats a pending Business Profile approval as a pass, not a failure', async () => {
    // docs/10 §1: while the access application is pending, quota sits at 0 QPM and every GBP call fails
    // however valid the token is. Reporting that as a failed test would teach the owner to ignore the
    // button for the six weeks it is the normal state.
    const log = createCallLog(() => NOW_ISO)
    const { deps } = harness({ gbpAccessGranted: false })
    const outcome = await testConnection(
      {
        ...deps,
        profile: createFakeBusinessProfile({
          log,
          failures: new FailureScript().failAlways('access_not_granted'),
          now: () => NOW_ISO,
        }),
      },
      CONNECTION_ID,
      NOW,
    )
    expect(outcome.state).toBe('pending_gbp_approval')
    expect(outcome.ok).toBe(true)
    // The control, and it is the same refusal: once Google says access is granted, the identical response
    // is a fault the owner has to act on.
    const approved = await testConnection(
      {
        ...harness({ gbpAccessGranted: true }).deps,
        profile: createFakeBusinessProfile({
          log,
          failures: new FailureScript().failAlways('access_not_granted'),
          now: () => NOW_ISO,
        }),
      },
      CONNECTION_ID,
      NOW,
    )
    expect(approved.ok).toBe(false)
    expect(approved.reason).toBe('capability_failing')
  })

  it('passes with the Testing expiry still to come, and says so in the state', async () => {
    // Consented five and a half days ago, so the seven-day expiry is 31 hours away — inside the 48-hour
    // window. Nothing is broken, so the test PASSES, and the state is the one the card renders the dated
    // tripwire under: the whole point of showing a deadline is that it appears before anything has failed.
    const { deps } = harness({
      publishingStatus: 'testing',
      consentAt: instantFromIso('2026-09-19T20:00:00.000Z'),
    })
    const outcome = await testConnection(deps, CONNECTION_ID, NOW)
    expect(outcome.ok).toBe(true)
    expect(outcome.state).toBe('expiring_soon')

    // The control: the same Testing status with the consent four days further out is 55 hours from
    // expiry, which is outside the window — so `expiring_soon` is about the deadline rather than about the
    // publishing status, which is what a single-branch assertion here would not have told anybody.
    const healthy = await testConnection(
      harness({ publishingStatus: 'testing', consentAt: CONSENT }).deps,
      CONNECTION_ID,
      NOW,
    )
    expect(healthy.state).toBe('healthy')
  })

  it('leaves no trace of the narrowing: the other connections are untouched', async () => {
    // The narrowed store overrides `listAll` only. A version that had narrowed `load` as well would break
    // the re-read the pass makes after a forced refresh, which is how a dead grant gets reported healthy.
    const { deps, store } = harness()
    const before = (await store.listAll()).length
    await testConnection(deps, CONNECTION_ID, NOW)
    expect((await store.listAll()).length).toBe(before)
    expect(await store.load(CONNECTION_ID)).not.toBeNull()
  })
})

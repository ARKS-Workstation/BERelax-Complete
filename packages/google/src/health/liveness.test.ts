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
  createFakeBusinessProfile,
  createFakeGoogleOAuth,
  createFakeSearchConsole,
} from '@berelax/providers/google'
import { describe, expect, it } from 'vitest'
import { connectionRecord, createMemoryConnectionStore } from '../memory-store.ts'
import { createMemoryRefreshLock } from '../token-refresh.ts'
import { connectionBinding, sealToken } from '../token-store.ts'
import type { WithGoogleDeps } from '../with-google.ts'
import { type LivenessDeps, livenessCapabilityFor, runLiveness } from './liveness.ts'

/**
 * The hourly probe: which capability it asks, which connections it skips, and what it does with a throw.
 *
 * Three claims, each paired with the case that must come out differently:
 *
 *  1. **Search Console first.** It is not behind the Basic API Access application, so it answers on launch
 *     day while every Business Profile call is refused — a probe that asked Business Profile first would
 *     report the launch-day normal as an outage, hourly, for the weeks the application takes. The control
 *     is a grant that carries only `business.manage`, which must fall back rather than skip.
 *  2. **A connection that is not `active` is skipped.** Twenty-four identical failure rows a day for a
 *     fact the status column already states is how a panel stops being read. The control is the `active`
 *     connection beside it, which is probed in the same pass.
 *  3. **A throw does not abandon the rest of the pass.** `withGoogle` throws for the classes a queue should
 *     retry; here that would mean one connection's blip leaving every later connection unprobed and
 *     reported as nothing at all.
 */
const KEK = generateKek('v1')
const NOW_ISO = '2026-09-19T04:00:00.000Z'
const NOW = instantFromIso(NOW_ISO)
const CONSENT = instantFromIso('2026-09-18T14:00:00.000Z')

const token = (id: string, sub: string) =>
  sealToken(KEK, connectionBinding({ connectionId: id, googleSub: sub }), `1//09-${id}`)

interface Seeded {
  readonly id: string
  readonly sub: string
  readonly scopes: readonly string[]
  readonly status?: 'active' | 'needs_reauth' | 'revoked' | 'disconnected'
  /** True to give the connection a cached token with fifty minutes left, so no refresh is due. */
  readonly cachedToken?: boolean
}

function harness(
  seeded: readonly Seeded[],
  options: { readonly apiFailures?: FailureScript } = {},
): { readonly deps: LivenessDeps; readonly store: ReturnType<typeof createMemoryConnectionStore> } {
  const store = createMemoryConnectionStore(
    seeded.map((row) =>
      connectionRecord({
        id: row.id,
        googleSub: row.sub,
        grantedScopes: row.scopes,
        refreshToken: token(row.id, row.sub),
        consentAt: CONSENT,
        ...(row.status === undefined ? {} : { status: row.status }),
        ...(row.cachedToken === true
          ? {
              accessToken: sealToken(
                KEK,
                connectionBinding({ connectionId: row.id, googleSub: row.sub }),
                'fake-access-cached',
              ),
              accessExpiresAt: (NOW + 50 * 60 * 1000) as Instant,
            }
          : {}),
      }),
    ),
  )
  // All four capability rows with NO resource chosen, which is exactly what `completeGoogleConsent`
  // leaves behind. It is also the state the probe is documented to survive and the reason it passes
  // `resource: 'enumerating'`: a connection whose listing has not been picked yet has a perfectly alive
  // token, and requiring a resource would report it as `ResourceNotSelected` for ever.
  //
  // Seeding them matters more than it looks. `resolveTarget` resolves a capability from its ROW, so a
  // connection with no rows at all resolves to `NotConnected` — which is what the first draft of this
  // file asserted `alive: true` against, and it failed. `enumerating` narrows the resource requirement
  // and does not conjure a capability nobody registered.
  for (const row of seeded) {
    for (const capability of ['gbp_reviews', 'gbp_location', 'gbp_performance', 'gsc'] as const) {
      store.putCapability({
        connectionId: row.id,
        capability,
        resourceRef: null,
        health: 'unknown',
        isPrimary: true,
      })
    }
  }
  const log = createCallLog(() => NOW_ISO)
  const failures = options.apiFailures ?? new FailureScript()
  const google: WithGoogleDeps = {
    store,
    oauth: createFakeGoogleOAuth({ log, failures: new FailureScript(), now: () => NOW_ISO }),
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
      profile: createFakeBusinessProfile({ log, failures, now: () => NOW_ISO }),
      searchConsole: createFakeSearchConsole({ log, failures, now: () => NOW_ISO }),
    },
  }
}

describe('livenessCapabilityFor', () => {
  it('prefers Search Console, because it is not gated behind the GBP application', () => {
    expect(livenessCapabilityFor([GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY])).toBe('gsc')
    expect(
      livenessCapabilityFor([GOOGLE_SCOPE_BUSINESS_MANAGE, GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY]),
    ).toBe('gsc')
  })

  it('falls back to a Business Profile read rather than skipping', () => {
    // The control on the preference. A probe that only knew how to ask Search Console would report a
    // GBP-only grant as unprobeable, which is indistinguishable from a grant nothing is watching.
    expect(livenessCapabilityFor([GOOGLE_SCOPE_BUSINESS_MANAGE])).toBe('gbp_location')
  })

  it('has nothing to ask a grant carrying neither scope', () => {
    expect(livenessCapabilityFor([])).toBeNull()
    expect(livenessCapabilityFor(['https://www.googleapis.com/auth/analytics.readonly'])).toBeNull()
  })
})

describe('runLiveness', () => {
  it('probes an active connection and moves last_ok_at', async () => {
    const { deps, store } = harness([
      { id: 'c-active', sub: 'sub-active', scopes: [GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY] },
    ])
    const result = await runLiveness(deps, NOW)
    expect(result.probes).toHaveLength(1)
    expect(result.probes[0]).toMatchObject({ capability: 'gsc', alive: true, skipped: null })
    const stored = await store.load('c-active')
    expect(stored?.lastOkAt).toBe(NOW)
    expect(stored?.lastCheckedAt).toBe(NOW)
  })

  it('skips the connections whose status says there is nothing to learn, and probes the one beside them', async () => {
    const { deps } = harness([
      { id: 'c-active', sub: 'sub-active', scopes: [GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY] },
      {
        id: 'c-dead',
        sub: 'sub-dead',
        scopes: [GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY],
        status: 'needs_reauth',
      },
      {
        id: 'c-gone',
        sub: 'sub-gone',
        scopes: [GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY],
        status: 'disconnected',
      },
      { id: 'c-scopeless', sub: 'sub-scopeless', scopes: [] },
    ])
    const result = await runLiveness(deps, NOW)
    const bySkip = Object.fromEntries(
      result.probes.map((probe) => [probe.connectionId, probe.skipped]),
    )
    expect(bySkip).toEqual({
      'c-active': null,
      'c-dead': 'not_active',
      'c-gone': 'disconnected',
      'c-scopeless': 'no_scope',
    })
    // The control: skipping is not the same as doing nothing at all. One connection really was probed,
    // so "everything was skipped" cannot be the reason this passes.
    expect(result.probes.filter((probe) => probe.alive)).toHaveLength(1)
  })

  it('degrades rather than throwing when the grant is refused', async () => {
    const { deps } = harness(
      [{ id: 'c-refused', sub: 'sub-refused', scopes: [GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY] }],
      { apiFailures: new FailureScript().failAlways('admin_policy_enforced') },
    )
    const result = await runLiveness(deps, NOW)
    expect(result.probes[0]).toMatchObject({ alive: false, cause: 'AdminPolicyEnforced' })
  })

  it('carries on past a connection whose failure withGoogle would have thrown', async () => {
    // `timeout` classifies `TransientUpstream`, which the chokepoint throws so an ordinary consumer's job
    // retries with backoff. Unhandled here it would abandon every connection after the first — and the
    // second connection would then be reported as nothing at all rather than as alive or dead.
    const { deps } = harness(
      [
        { id: 'c-blip', sub: 'sub-blip', scopes: [GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY] },
        { id: 'c-later', sub: 'sub-later', scopes: [GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY] },
      ],
      { apiFailures: new FailureScript().failAlways('timeout') },
    )
    const result = await runLiveness(deps, NOW)
    expect(result.probes).toHaveLength(2)
    for (const probe of result.probes) {
      expect(probe.alive).toBe(false)
      expect(probe.cause).toBe('TransientUpstream')
      expect(probe.skipped).toBeNull()
    }
  })

  it('records that it looked even when nothing worked', async () => {
    // A cached token with fifty minutes left, so nothing is due and the probe makes no refresh — which is
    // also the claim that separates it from the deep check. Without that, the refresh itself succeeds and
    // moves `last_ok_at` legitimately (a refresh IS an authenticated call Google answered), and this
    // assertion would be about the wrong thing. The first draft of it was.
    const { deps, store } = harness(
      [
        {
          id: 'c-blip',
          sub: 'sub-blip',
          scopes: [GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY],
          cachedToken: true,
        },
      ],
      { apiFailures: new FailureScript().failAlways('timeout') },
    )
    await runLiveness(deps, NOW)
    const stored = await store.load('c-blip')
    // `last_checked_at` moved and `last_ok_at` did not: "we looked and it did not work" has to be
    // distinguishable from "nothing has looked", because those need different actions.
    expect(stored?.lastCheckedAt).toBe(NOW)
    expect(stored?.lastOkAt).toBeNull()
  })
})

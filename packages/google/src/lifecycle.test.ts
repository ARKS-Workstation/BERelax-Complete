import { generateKek } from '@berelax/clinical'
import {
  fixedClock,
  type Instant,
  instantFromIso,
  TESTING_REFRESH_TOKEN_DAYS as TRIPWIRE_DAYS,
} from '@berelax/core'
import { createCallLog } from '@berelax/providers/call-log'
import { FailureScript } from '@berelax/providers/failure'
import {
  createFakeGoogleOAuth,
  TESTING_REFRESH_TOKEN_DAYS as FAKE_EXPIRY_DAYS,
} from '@berelax/providers/google'
import { AppError, isAppError } from '@berelax/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  accessTokenFor,
  grantFailureFromError,
  refreshAccessToken,
  type TokenLifecycleDeps,
} from './lifecycle.ts'
import { connectionRecord, createMemoryConnectionStore } from './memory-store.ts'
import { connectionBinding, openToken, sealToken } from './token-store.ts'

const KEK = generateKek('v1')
const NOW_ISO = '2026-09-18T10:00:00.000Z'
const NOW = instantFromIso(NOW_ISO)
const CONNECTION_ID = '01920000-0000-7000-8000-00000000000a'
const SUB = '104729518362094771533'
const REFRESH_TOKEN = '1//09-owner-refresh-token'

const binding = connectionBinding({ connectionId: CONNECTION_ID, googleSub: SUB })

type RecordArgs = Parameters<typeof connectionRecord>[0]

function seeded(overrides: Partial<RecordArgs> = {}) {
  return connectionRecord({
    id: CONNECTION_ID,
    googleSub: SUB,
    refreshToken: sealToken(KEK, binding, REFRESH_TOKEN),
    consentAt: instantFromIso('2026-09-17T10:00:00.000Z'),
    ...overrides,
  })
}

let failures: FailureScript
let deps: TokenLifecycleDeps
let store: ReturnType<typeof createMemoryConnectionStore>

beforeEach(() => {
  failures = new FailureScript()
  store = createMemoryConnectionStore([seeded()])
  deps = {
    store,
    oauth: createFakeGoogleOAuth({
      log: createCallLog(() => NOW_ISO),
      failures,
      now: () => NOW_ISO,
      sub: SUB,
    }),
    kek: KEK,
    clock: fixedClock(NOW_ISO),
  }
})

describe('obtaining an access token', () => {
  it('refreshes when there is no cached token, and records the success', async () => {
    const grant = await accessTokenFor(deps, CONNECTION_ID)
    expect(grant.refreshed).toBe(true)
    expect(grant.accessToken).toMatch(/^fake-access-/)

    const [record] = store.records()
    expect(record?.lastOkAt).toBe(NOW)
    expect(record?.accessToken).not.toBeNull()
    expect(store.events().map((e) => e.event)).toEqual(['refreshed'])
  })

  it('stores the access token sealed, and it round-trips', async () => {
    await accessTokenFor(deps, CONNECTION_ID)
    const cached = store.records()[0]?.accessToken
    if (cached === undefined || cached === null) throw new Error('no cached access token')
    expect(cached.ct.toString('latin1')).not.toContain('fake-access-')
    expect(openToken(KEK, binding, cached)).toMatch(/^fake-access-/)
  })

  it('reuses a cached token that is not yet inside the refresh margin', async () => {
    // The control on proactive refresh: a token with an hour left must cost no round trip.
    const cachedToken = 'fake-access-cached'
    store.put(
      seeded({
        accessToken: sealToken(KEK, binding, cachedToken),
        accessExpiresAt: (NOW + 3_600_000) as Instant,
      }),
    )
    const grant = await accessTokenFor(deps, CONNECTION_ID)
    expect(grant.refreshed).toBe(false)
    expect(grant.accessToken).toBe(cachedToken)
    expect(store.events()).toEqual([])
  })

  it('replaces a cached token that expires inside the margin', async () => {
    store.put(
      seeded({
        accessToken: sealToken(KEK, binding, 'fake-access-nearly-dead'),
        accessExpiresAt: (NOW + 60_000) as Instant,
      }),
    )
    const grant = await accessTokenFor(deps, CONNECTION_ID)
    expect(grant.refreshed).toBe(true)
    expect(grant.accessToken).not.toBe('fake-access-nearly-dead')
  })

  it('reports not_found for a connection that does not exist', async () => {
    await expect(accessTokenFor(deps, '01920000-0000-7000-8000-0000000000ff')).rejects.toThrow(
      AppError,
    )
  })
})

describe('the invalid_grant path', () => {
  it('marks the connection needs_reauth, records the reason, and throws a re-auth error', async () => {
    // This is the seven-day Testing expiry, a revocation at myaccount.google.com, and six months
    // unused — all of them arrive as this one error.
    failures.failAlways('invalid_grant')
    const error = await accessTokenFor(deps, CONNECTION_ID).catch((e: unknown) => e)
    expect(isAppError(error)).toBe(true)
    if (!isAppError(error)) throw new Error('expected an AppError')
    expect(error.kind).toBe('unauthenticated')
    expect(error.details['reason']).toBe('google_reauth_required')

    const record = store.records()[0]
    expect(record?.status).toBe('needs_reauth')
    expect(record?.statusReason).toBe('invalid_grant')
    expect(record?.lastCheckedAt).toBe(NOW)
  })

  it('writes a row the dashboard renders, because nobody reads pgboss.job', async () => {
    failures.failAlways('invalid_grant')
    await accessTokenFor(deps, CONNECTION_ID).catch(() => undefined)
    const events = store.events()
    expect(events.map((e) => e.event)).toEqual(['reauth_required'])
    expect(events[0]?.detail).toMatchObject({
      failure: 'invalid_grant',
      notified: 'reauth_required',
    })
  })

  it('does not email twice for the same dead connection', async () => {
    // Three Google jobs per cycle would otherwise mean three identical emails per cycle.
    failures.failAlways('invalid_grant')
    await accessTokenFor(deps, CONNECTION_ID).catch(() => undefined)
    // The second attempt hits the status guard before any refresh, which is itself the dedupe.
    await accessTokenFor(deps, CONNECTION_ID).catch(() => undefined)
    expect(store.events()).toHaveLength(1)

    // And a direct refresh of the already-dead row records the failure without notifying again.
    const dead = store.records()[0]
    if (dead === undefined) throw new Error('no record')
    await refreshAccessToken(deps, dead).catch(() => undefined)
    const events = store.events()
    expect(events).toHaveLength(2)
    expect(events[1]?.event).toBe('refresh_failed')
    expect(events[1]?.detail).toMatchObject({ notified: 'none' })
  })

  it('never puts the token in the event payload', async () => {
    // The memory store refuses a payload carrying a token key, exactly as the CHECK constraint does.
    failures.failAlways('invalid_grant')
    await accessTokenFor(deps, CONNECTION_ID).catch(() => undefined)
    const serialised = JSON.stringify(store.events())
    expect(serialised).not.toContain(REFRESH_TOKEN)
  })

  it('refuses to serve a token for a connection already needing re-auth', async () => {
    store.put(seeded({ status: 'needs_reauth', statusReason: 'invalid_grant' }))
    await expect(accessTokenFor(deps, CONNECTION_ID)).rejects.toThrow(/needs re-authorising/)
  })

  it('refuses to serve a token for a disconnected connection', async () => {
    store.put(seeded({ status: 'disconnected', statusReason: 'manual' }))
    await expect(accessTokenFor(deps, CONNECTION_ID)).rejects.toThrow(/needs re-authorising/)
  })
})

describe('failures that are not invalid_grant', () => {
  it('leave the grant active and rethrow the provider error untouched', async () => {
    // The control: a quota error must not send the owner through a re-consent that fixes nothing.
    failures.failAlways('quota_exhausted')
    const error = await accessTokenFor(deps, CONNECTION_ID).catch((e: unknown) => e)
    expect(isAppError(error)).toBe(true)
    if (!isAppError(error)) throw new Error('expected an AppError')
    expect(error.details['reason']).toBeUndefined()

    const record = store.records()[0]
    expect(record?.status).toBe('active')
    expect(record?.statusReason).toBeNull()
    expect(store.events().map((e) => e.event)).toEqual(['health_check_failed'])
  })

  it('classify into the state machine vocabulary, defaulting to transient', () => {
    const modes = [
      ['invalid_grant', 'invalid_grant'],
      ['access_not_granted', 'access_not_granted'],
      ['quota_exhausted', 'quota_zero'],
      ['rate_limited', 'rate_limited'],
      ['timeout', 'transient'],
      ['server_error', 'transient'],
    ] as const
    for (const [mode, expected] of modes) {
      const error = new AppError('provider_unavailable', 'x', { details: { failureMode: mode } })
      expect(grantFailureFromError(error)).toBe(expected)
    }
    // An error from outside the provider layer carries no failure mode at all. It must NOT be read as
    // invalid_grant, or a DNS blip marks a working connection dead.
    expect(grantFailureFromError(new Error('ECONNRESET'))).toBe('transient')
  })
})

describe('a rotated refresh token', () => {
  it('is persisted when Google returns a different one', async () => {
    // Google normally returns the same token. Silently discarding a rotated one is a time bomb: the old
    // token stops working at a moment nothing in the deploy log explains.
    const stored = store.records()[0]
    if (stored === undefined) throw new Error('no record')
    const before = stored.refreshToken.ct

    // The fake issues a refresh token only on consent, so exchangeCode is how a rotation is simulated.
    const consent = await deps.oauth.exchangeCode('code-1')
    expect(consent.refreshToken).toBeDefined()
    const rotatedDeps: TokenLifecycleDeps = {
      ...deps,
      oauth: {
        ...deps.oauth,
        refresh: async () => ({ ...consent, refreshToken: 'fake-refresh-rotated' }),
      },
    }
    await refreshAccessToken(rotatedDeps, stored)

    const after = store.records()[0]?.refreshToken
    if (after === undefined) throw new Error('no record')
    expect(after.ct.equals(before)).toBe(false)
    expect(openToken(KEK, binding, after)).toBe('fake-refresh-rotated')
    expect(store.events()[0]?.detail).toMatchObject({ rotatedRefreshToken: true })
  })

  it('leaves the stored token alone when Google returns none', async () => {
    const stored = store.records()[0]
    if (stored === undefined) throw new Error('no record')
    const before = stored.refreshToken.ct
    await accessTokenFor(deps, CONNECTION_ID)
    expect(store.records()[0]?.refreshToken.ct.equals(before)).toBe(true)
    expect(store.events()[0]?.detail).toMatchObject({ rotatedRefreshToken: false })
  })
})

describe('the Testing-status expiry the fake reproduces', () => {
  it('is the same seven days the tripwire computes', () => {
    // Two constants, one fact, and this is the only place both are importable. If the fake's expiry and
    // the settings-panel tripwire drift apart, the panel shows a date the system does not believe in —
    // and the drift is invisible, because each side is internally consistent.
    expect(TRIPWIRE_DAYS).toBe(FAKE_EXPIRY_DAYS)
    expect(TRIPWIRE_DAYS).toBe(7)
  })
})

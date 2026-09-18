import { AppError } from '@berelax/shared'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { type Instant, instantFromIso, instantToIso } from '../time.ts'
import {
  ACCESS_TOKEN_REFRESH_MARGIN_MINUTES,
  applyGrantFailure,
  applyRefreshSuccess,
  CAPABILITY_SCOPE,
  type CapabilityState,
  CONNECTION_STALE_AFTER_HOURS,
  type ConnectionSnapshot,
  capabilityHealthAtConsent,
  capabilityHealthFromScopes,
  deriveConnectionHealth,
  FORBIDDEN_GOOGLE_SCOPES,
  forbiddenScopesIn,
  GOOGLE_SCOPE_BUSINESS_MANAGE,
  GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY,
  hoursBetween,
  isBusinessProfileCapability,
  missingScopesFor,
  REQUESTED_GOOGLE_SCOPES,
  shouldRefreshAccessToken,
  TESTING_REFRESH_TOKEN_DAYS,
  testingRefreshTokenExpiry,
} from './connection.ts'

const NOW = instantFromIso('2026-09-18T10:00:00.000Z')
const HOUR = 3_600_000
const DAY = 24 * HOUR

const hoursAgo = (n: number): Instant => (NOW - n * HOUR) as Instant
const daysAgo = (n: number): Instant => (NOW - n * DAY) as Instant

const BOTH_SCOPES = [GOOGLE_SCOPE_BUSINESS_MANAGE, GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY]

const ALL_OK: readonly CapabilityState[] = [
  { capability: 'gbp_reviews', health: 'ok' },
  { capability: 'gsc', health: 'ok' },
]

/** A connection that is genuinely fine: consented yesterday, called successfully an hour ago. */
function healthy(overrides: Partial<ConnectionSnapshot> = {}): ConnectionSnapshot {
  return {
    status: 'active',
    consentAt: daysAgo(1),
    lastOkAt: hoursAgo(1),
    grantedScopes: BOTH_SCOPES,
    capabilities: ALL_OK,
    consentScreenInTesting: true,
    gbpAccessGranted: true,
    ...overrides,
  }
}

describe('the seven-day Testing tripwire', () => {
  it('expires exactly seven days after consent', () => {
    const consentAt = instantFromIso('2026-09-11T06:00:00.000Z')
    expect(instantToIso(testingRefreshTokenExpiry(consentAt))).toBe('2026-09-18T06:00:00.000Z')
  })

  it('is not six days and not eight — the control that makes the date above mean something', () => {
    const consentAt = instantFromIso('2026-09-11T06:00:00.000Z')
    const expiry = testingRefreshTokenExpiry(consentAt)
    expect(instantToIso(expiry)).not.toBe('2026-09-17T06:00:00.000Z')
    expect(instantToIso(expiry)).not.toBe('2026-09-19T06:00:00.000Z')
    expect(expiry - consentAt).toBe(TESTING_REFRESH_TOKEN_DAYS * DAY)
  })

  it('holds for any consent instant', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4_000_000_000_000 }), (ms) => {
        const consentAt = ms as Instant
        return testingRefreshTokenExpiry(consentAt) - consentAt === TESTING_REFRESH_TOKEN_DAYS * DAY
      }),
    )
  })
})

describe('proactive access-token refresh', () => {
  it('is due when there is no cached token at all', () => {
    expect(shouldRefreshAccessToken({ accessExpiresAt: null, now: NOW })).toBe(true)
  })

  it('is due inside the margin and NOT due outside it', () => {
    const margin = ACCESS_TOKEN_REFRESH_MARGIN_MINUTES * 60_000
    const insideMargin = (NOW + margin - 1000) as Instant
    const outsideMargin = (NOW + margin + 1000) as Instant
    expect(shouldRefreshAccessToken({ accessExpiresAt: insideMargin, now: NOW })).toBe(true)
    // The control: a token with more than the margin left must not be refreshed, or every cron cycle
    // spends a round trip on a token that was already good.
    expect(shouldRefreshAccessToken({ accessExpiresAt: outsideMargin, now: NOW })).toBe(false)
  })

  it('is due for a token that has already expired', () => {
    expect(shouldRefreshAccessToken({ accessExpiresAt: hoursAgo(2), now: NOW })).toBe(true)
  })
})

describe('hoursBetween', () => {
  it('counts whole elapsed hours and goes negative for a future instant', () => {
    expect(hoursBetween(hoursAgo(50), NOW)).toBe(50)
    expect(hoursBetween(NOW, hoursAgo(3))).toBe(-3)
  })
})

describe('scopes and capabilities', () => {
  it('requests exactly the two scopes from docs/10 §3 and never the read-write Search Console one', () => {
    expect([...REQUESTED_GOOGLE_SCOPES].sort()).toEqual([...BOTH_SCOPES].sort())
    expect(REQUESTED_GOOGLE_SCOPES).not.toContain('https://www.googleapis.com/auth/webmasters')
    expect(REQUESTED_GOOGLE_SCOPES.some((s) => s.includes('gmail'))).toBe(false)
  })

  it('maps every Business Profile capability to the one scope that exists for it', () => {
    expect(CAPABILITY_SCOPE.gbp_reviews).toBe(GOOGLE_SCOPE_BUSINESS_MANAGE)
    expect(CAPABILITY_SCOPE.gbp_location).toBe(GOOGLE_SCOPE_BUSINESS_MANAGE)
    expect(CAPABILITY_SCOPE.gbp_performance).toBe(GOOGLE_SCOPE_BUSINESS_MANAGE)
    expect(CAPABILITY_SCOPE.gsc).toBe(GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY)
    expect(isBusinessProfileCapability('gsc')).toBe(false)
    expect(isBusinessProfileCapability('gbp_location')).toBe(true)
  })

  it('reports the missing scope once however many capabilities need it', () => {
    const missing = missingScopesFor(
      ['gbp_reviews', 'gbp_location', 'gbp_performance'],
      [GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY],
    )
    expect(missing).toEqual([GOOGLE_SCOPE_BUSINESS_MANAGE])
  })

  it('reports nothing missing when the grant covers everything asked for', () => {
    expect(missingScopesFor(['gbp_reviews', 'gsc'], BOTH_SCOPES)).toEqual([])
  })

  it('derives capability health from what Google returned, not from what was requested', () => {
    // The fake consent screen that returns only webmasters.readonly is the case this exists for.
    expect(capabilityHealthFromScopes('gbp_reviews', [GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY])).toBe(
      'permission_missing',
    )
    expect(capabilityHealthFromScopes('gsc', [GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY])).toBe('ok')
  })
})

describe('the displayed state, derived', () => {
  it('reads never_connected with no connection at all, and notifies nobody', () => {
    const health = deriveConnectionHealth(null, NOW)
    expect(health.displayState).toBe('never_connected')
    expect(health.notify).toBeNull()
    expect(health.testingExpiresAt).toBeNull()
  })

  it('reads never_connected — not broken — for a deliberate disconnect', () => {
    // The owner did this on purpose. Emailing them daily about their own action is how a notification
    // channel gets muted.
    const health = deriveConnectionHealth(healthy({ status: 'disconnected' }), NOW)
    expect(health.displayState).toBe('never_connected')
    expect(health.notify).toBeNull()
  })

  it('reads healthy when the grant works and was verified within the hour', () => {
    const health = deriveConnectionHealth(healthy(), NOW)
    expect(health.displayState).toBe('healthy')
    expect(health.hoursSinceLastSuccess).toBe(1)
    expect(health.stale).toBe(false)
    expect(health.notify).toBeNull()
  })

  it('reads healthy for a connection consented minutes ago that has not called anything yet', () => {
    // The control on the staleness rule. Without the fallback to consentAt, a brand-new connection
    // reads degraded the instant it is created and the owner is emailed about a working grant.
    const fresh = healthy({ lastOkAt: null, consentAt: NOW })
    const health = deriveConnectionHealth(fresh, NOW)
    expect(health.displayState).toBe('healthy')
    expect(health.hoursSinceLastSuccess).toBeNull()
    expect(health.stale).toBe(false)
  })

  it('reads broken and asks for re-auth when the grant needs re-consent', () => {
    const health = deriveConnectionHealth(healthy({ status: 'needs_reauth' }), NOW)
    expect(health.displayState).toBe('broken')
    expect(health.notify).toBe('reauth_required')
  })

  it('reads broken when the owner revoked the grant at Google', () => {
    expect(deriveConnectionHealth(healthy({ status: 'revoked' }), NOW).displayState).toBe('broken')
  })

  it('refuses to read healthy when nothing has succeeded for two days', () => {
    // "Connected" with no recency is exactly how silent failure hides (docs/10 §4).
    const stale = healthy({ lastOkAt: hoursAgo(CONNECTION_STALE_AFTER_HOURS + 3) })
    const health = deriveConnectionHealth(stale, NOW)
    expect(health.stale).toBe(true)
    expect(health.displayState).toBe('degraded')
    expect(health.notify).toBe('predictive_warning')
  })

  it('still reads healthy one hour short of the staleness window', () => {
    const nearly = healthy({ lastOkAt: hoursAgo(CONNECTION_STALE_AFTER_HOURS - 1) })
    expect(deriveConnectionHealth(nearly, NOW).displayState).toBe('healthy')
  })

  it('warns before the stop when a Testing expiry is inside 48 hours', () => {
    const health = deriveConnectionHealth(healthy({ consentAt: daysAgo(6) }), NOW)
    expect(health.displayState).toBe('expiring_soon')
    expect(health.hoursUntilTestingExpiry).toBe(24)
    expect(health.notify).toBe('predictive_warning')
  })

  it('computes no expiry at all once the consent screen is published', () => {
    // The control: the same six-day-old consent is unremarkable on a published screen, and reporting
    // an expiry there would be a false alarm that costs credibility on the real ones.
    const published = healthy({ consentAt: daysAgo(6), consentScreenInTesting: false })
    const health = deriveConnectionHealth(published, NOW)
    expect(health.testingExpiresAt).toBeNull()
    expect(health.hoursUntilTestingExpiry).toBeNull()
    expect(health.expiringSoon).toBe(false)
    expect(health.displayState).toBe('healthy')
  })

  it('reads pending_gbp_approval — not degraded — while Google reviews the access application', () => {
    // Weeks of amber is the launch-day normal. Weeks of red teaches the owner to ignore red.
    const pending = healthy({
      gbpAccessGranted: false,
      capabilities: [
        { capability: 'gbp_reviews', health: 'quota_zero' },
        { capability: 'gsc', health: 'ok' },
      ],
    })
    const health = deriveConnectionHealth(pending, NOW)
    expect(health.displayState).toBe('pending_gbp_approval')
    expect(health.pendingGbpCapabilities).toEqual(['gbp_reviews'])
    expect(health.failingCapabilities).toEqual([])
    expect(health.notify).toBeNull()
  })

  it('reads degraded for the same failure once access HAS been granted', () => {
    const granted = healthy({
      gbpAccessGranted: true,
      capabilities: [
        { capability: 'gbp_reviews', health: 'quota_zero' },
        { capability: 'gsc', health: 'ok' },
      ],
    })
    const health = deriveConnectionHealth(granted, NOW)
    expect(health.displayState).toBe('degraded')
    expect(health.failingCapabilities).toEqual(['gbp_reviews'])
    expect(health.pendingGbpCapabilities).toEqual([])
  })

  it('never hides a real failure behind the pending-approval state', () => {
    const mixed = healthy({
      gbpAccessGranted: false,
      capabilities: [
        { capability: 'gbp_reviews', health: 'permission_missing' },
        { capability: 'gsc', health: 'not_verified' },
      ],
    })
    const health = deriveConnectionHealth(mixed, NOW)
    expect(health.displayState).toBe('degraded')
    expect(health.failingCapabilities).toEqual(['gsc'])
    expect(health.pendingGbpCapabilities).toEqual(['gbp_reviews'])
  })

  it('treats an unverified Search Console property as a real failure, not a pending approval', () => {
    // Search Console is not access-gated. Filing its failure under "waiting for Google" would leave a
    // property that was never verified sitting amber forever.
    const gscBroken = healthy({
      gbpAccessGranted: false,
      capabilities: [{ capability: 'gsc', health: 'not_verified' }],
    })
    expect(deriveConnectionHealth(gscBroken, NOW).failingCapabilities).toEqual(['gsc'])
  })

  it('surfaces the scope a capability is missing so the panel can name it in English', () => {
    const partial = healthy({
      grantedScopes: [GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY],
      capabilities: [
        { capability: 'gbp_reviews', health: 'permission_missing' },
        { capability: 'gsc', health: 'ok' },
      ],
    })
    expect(deriveConnectionHealth(partial, NOW).missingScopes).toEqual([
      GOOGLE_SCOPE_BUSINESS_MANAGE,
    ])
  })
})

describe('grant failures', () => {
  it('turns invalid_grant into needs_reauth and emails once', () => {
    const transition = applyGrantFailure({ status: 'active', statusReason: null }, 'invalid_grant')
    expect(transition.status).toBe('needs_reauth')
    expect(transition.statusReason).toBe('invalid_grant')
    expect(transition.event).toBe('reauth_required')
    expect(transition.notify).toBe('reauth_required')
  })

  it('does not email again for a connection already known to be dead', () => {
    // Three Google jobs per cycle would otherwise send three identical emails per cycle.
    const second = applyGrantFailure(
      { status: 'needs_reauth', statusReason: 'invalid_grant' },
      'invalid_grant',
    )
    expect(second.notify).toBeNull()
    expect(second.event).toBe('refresh_failed')
    expect(second.status).toBe('needs_reauth')
  })

  it('leaves the grant alone for every failure that is not invalid_grant', () => {
    // The control: a quota error or a 500 must not send the owner through a re-consent that fixes
    // nothing. Only invalid_grant means the token is dead.
    for (const failure of [
      'rate_limited',
      'quota_zero',
      'transient',
      'access_not_granted',
    ] as const) {
      const transition = applyGrantFailure({ status: 'active', statusReason: null }, failure)
      expect(transition.status).toBe('active')
      expect(transition.notify).toBeNull()
      expect(transition.event).toBe('health_check_failed')
    }
  })

  it('keeps an existing status reason rather than blanking it on an unrelated failure', () => {
    const transition = applyGrantFailure(
      { status: 'active', statusReason: 'scope_removed' },
      'rate_limited',
    )
    expect(transition.statusReason).toBe('scope_removed')
  })
})

describe('refresh success', () => {
  it('brings a needs_reauth connection back to active and clears the reason', () => {
    const transition = applyRefreshSuccess({ status: 'needs_reauth' })
    expect(transition.status).toBe('active')
    expect(transition.statusReason).toBeNull()
    expect(transition.event).toBe('refreshed')
  })

  it('refuses to resurrect a disconnected connection', () => {
    // Offboarding revoked the token at Google on purpose. A stray job reviving the row would hide that
    // from whoever runs the business next.
    expect(() => applyRefreshSuccess({ status: 'disconnected' })).toThrow(AppError)
  })
})

describe('the forbidden scope list', () => {
  it('flags the read-write webmasters scope without flagging the read-only one', () => {
    // `auth/webmasters` is a prefix of `auth/webmasters.readonly`, so a substring check would report
    // the scope we DO want as forbidden — and the natural fix for that false positive is deleting the
    // check. Whole-scope comparison is the point of the function, so it is what is asserted.
    expect(forbiddenScopesIn([GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY])).toEqual([])
    expect(forbiddenScopesIn(['https://www.googleapis.com/auth/webmasters'])).toEqual([
      'https://www.googleapis.com/auth/webmasters',
    ])
  })

  it('passes the two scopes this system requests and rejects Gmail and Analytics', () => {
    expect(forbiddenScopesIn(REQUESTED_GOOGLE_SCOPES)).toEqual([])
    for (const scope of [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://mail.google.com/',
      'https://www.googleapis.com/auth/analytics.readonly',
    ]) {
      expect(forbiddenScopesIn([scope])).toEqual([scope])
    }
  })

  it('never lists a forbidden scope that is also one of the two requested', () => {
    // A list that forbade a requested scope would make every consent impossible, and the symptom would
    // be a refusal in the connect route rather than a failing test here.
    for (const scope of REQUESTED_GOOGLE_SCOPES) {
      expect(FORBIDDEN_GOOGLE_SCOPES).not.toContain(scope)
    }
  })
})

describe('capability health at consent', () => {
  it('is permission_missing when the scope was not granted, whatever was there before', () => {
    for (const existingHealth of ['ok', 'quota_zero', 'not_verified', null] as const) {
      expect(
        capabilityHealthAtConsent({
          capability: 'gbp_reviews',
          grantedScopes: [GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY],
          existingHealth,
        }),
      ).toBe('permission_missing')
    }
  })

  it('is unknown rather than ok for a freshly granted scope', () => {
    // The control that matters: `capabilityHealthFromScopes` says `ok` for the same input, and using
    // that here would put a green tick on a capability nothing has exercised. A fresh grant proves the
    // owner ticked the product, not that the listing is verified or the quota is above zero.
    expect(capabilityHealthFromScopes('gsc', [GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY])).toBe('ok')
    expect(
      capabilityHealthAtConsent({
        capability: 'gsc',
        grantedScopes: [GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY],
        existingHealth: null,
      }),
    ).toBe('unknown')
  })

  it('clears a previous permission_missing but preserves every other observed failure', () => {
    expect(
      capabilityHealthAtConsent({
        capability: 'gsc',
        grantedScopes: BOTH_SCOPES,
        existingHealth: 'permission_missing',
      }),
    ).toBe('unknown')
    for (const existingHealth of ['ok', 'quota_zero', 'not_verified'] as const) {
      expect(
        capabilityHealthAtConsent({
          capability: 'gsc',
          grantedScopes: BOTH_SCOPES,
          existingHealth,
        }),
      ).toBe(existingHealth)
    }
  })
})

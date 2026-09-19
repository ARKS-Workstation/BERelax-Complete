import {
  CONNECTION_STALE_AFTER_HOURS,
  deriveConnectionHealth,
  type Instant,
  instantFromIso,
  TESTING_REFRESH_TOKEN_DAYS,
} from '@berelax/core'
import { TESTING_REFRESH_TOKEN_DAYS as FAKE_TESTING_DAYS } from '@berelax/providers/google'
import { describe, expect, it } from 'vitest'
import {
  escapeHtml,
  GOOGLE_PUBLISHING_STATUSES,
  isGooglePublishingStatus,
  renderConnectionHealth,
  renderTestingExpiry,
  spellDate,
  TESTING_EXPIRY_TRIPWIRE,
  testingExpiryFor,
} from './testing-expiry.ts'

/**
 * The Testing-expiry tripwire, proved able to fire and able not to.
 *
 * The three things worth asserting here, in order of how badly each one fails silently:
 *
 *  1. **It fires before the outage.** The warning window opens 48 hours before the expiry, and the
 *     expiry is day seven — so the warning lands on day five, which is two days of usable notice. A
 *     tripwire that fired *with* the failure is a report, not a tripwire.
 *  2. **It can be absent.** A published consent screen has no fuse, so the element is not rendered at
 *     all. A check that can only pass is not a check (ADR 0003), and `hidden` would have made the
 *     absence unassertable.
 *  3. **The fake and the arithmetic agree.** The fake's seven days and core's seven days are separate
 *     constants in separate packages, and a test standing on either side of the wrong one would prove
 *     nothing about the real thing.
 */

const DAY = 24 * 60 * 60 * 1000
const CONSENT_ISO = '2026-09-18T14:00:00.000Z'
const CONSENT = instantFromIso(CONSENT_ISO)
const at = (millis: number): Instant => (CONSENT + millis) as Instant

describe('the fake and the tripwire cannot drift apart', () => {
  it('expires a Testing grant on the same day in both packages', () => {
    // Two constants, two packages, one deadline. Without this, a fake that expired at ten days would
    // make every "the tripwire warned first" assertion below pass for the wrong reason.
    expect(FAKE_TESTING_DAYS).toBe(TESTING_REFRESH_TOKEN_DAYS)
    expect(TESTING_REFRESH_TOKEN_DAYS).toBe(7)
  })
})

describe('testingExpiryFor', () => {
  it('is null for a published consent screen, so there is no date to render', () => {
    expect(
      testingExpiryFor({ publishingStatus: 'production', consentAt: CONSENT, now: at(0) }),
    ).toBeNull()
  })

  it('computes consent_at + 7 days, in Asia/Dubai, on the day consent was given', () => {
    const view = testingExpiryFor({
      publishingStatus: 'testing',
      consentAt: CONSENT,
      now: at(0),
    })
    // 14:00 UTC on the 18th is 18:00 Gulf time; seven days later is the 25th, still 18:00. Asserting the
    // LOCAL date rather than the UTC one is the point: a fuse rendered in UTC would name the 25th for a
    // consent at 21:00 Gulf time whose expiry is the 26th where the owner is standing.
    expect(view?.expiresOn).toBe('2026-09-25')
    expect(view?.label).toBe('25 September 2026 at 18:00 (Asia/Dubai)')
    expect(view?.hoursRemaining).toBe(TESTING_REFRESH_TOKEN_DAYS * 24)
    expect(view?.expired).toBe(false)
  })

  it('opens the warning window 48 hours before the expiry, and not before', () => {
    // Whole hours, because `hoursBetween` floors — so the boundary is asserted at the granularity the
    // arithmetic actually has rather than at a minute it does not distinguish. Fifty hours out is silent;
    // exactly forty-eight is due, which is day five of seven and two clear days of notice.
    const fiftyHoursOut = testingExpiryFor({
      publishingStatus: 'testing',
      consentAt: CONSENT,
      now: at(5 * DAY - 2 * 60 * 60 * 1000),
    })
    const fortyEightHoursOut = testingExpiryFor({
      publishingStatus: 'testing',
      consentAt: CONSENT,
      now: at(5 * DAY),
    })
    expect(fiftyHoursOut?.hoursRemaining).toBe(50)
    expect(fiftyHoursOut?.warningDue).toBe(false)
    expect(fortyEightHoursOut?.hoursRemaining).toBe(48)
    expect(fortyEightHoursOut?.warningDue).toBe(true)
    // And the window is the same 48 hours the predictive email uses, read from the constant rather than
    // from a second copy of the number.
    expect(fortyEightHoursOut?.hoursRemaining).toBe(CONNECTION_STALE_AFTER_HOURS)
  })

  it('reports an expiry that has passed as passed rather than as a future date', () => {
    const view = testingExpiryFor({
      publishingStatus: 'testing',
      consentAt: CONSENT,
      now: at(8 * DAY),
    })
    expect(view?.expired).toBe(true)
    expect(view?.hoursRemaining).toBeLessThan(0)
  })

  it('warns two days before deriveConnectionHealth calls the connection expiring_soon, not after', () => {
    // The ordering claim, and the reason the tripwire exists as a rendered date at all: the derivation
    // only reaches `expiring_soon` inside the 48-hour window, whereas the date is on the screen from day
    // one. Asserted as a pair so the two cannot be reconciled by moving one of them.
    const snapshot = {
      status: 'active' as const,
      consentAt: CONSENT,
      lastOkAt: null,
      grantedScopes: [],
      capabilities: [],
      consentScreenInTesting: true,
      gbpAccessGranted: true,
    }
    const dayOne = at(60 * 60 * 1000)
    expect(deriveConnectionHealth(snapshot, dayOne).expiringSoon).toBe(false)
    expect(
      testingExpiryFor({ publishingStatus: 'testing', consentAt: CONSENT, now: dayOne }),
    ).not.toBeNull()

    const daySix = at(6 * DAY)
    expect(deriveConnectionHealth(snapshot, daySix).expiringSoon).toBe(true)
    expect(deriveConnectionHealth(snapshot, daySix).notify).toBe('predictive_warning')
  })
})

describe('renderTestingExpiry', () => {
  it('renders the tripwire element carrying the dated expiry', () => {
    const html = renderTestingExpiry(
      testingExpiryFor({ publishingStatus: 'testing', consentAt: CONSENT, now: at(0) }),
    )
    expect(html).toContain(`data-tripwire="${TESTING_EXPIRY_TRIPWIRE}"`)
    expect(html).toContain('data-expires-on="2026-09-25"')
    expect(html).toContain('25 September 2026')
  })

  it('renders NOTHING for a published consent screen', () => {
    // The branch that makes this a check. The DOM assertion lives in the integration suite; this is the
    // same claim at the string level, so a regression fails in two seconds rather than after a browser.
    expect(renderTestingExpiry(null)).toBe('')
  })

  it('says the expiry has passed rather than counting down from a negative number', () => {
    const html = renderTestingExpiry(
      testingExpiryFor({ publishingStatus: 'testing', consentAt: CONSENT, now: at(9 * DAY) }),
    )
    expect(html).toContain('expired on')
    // Not a countdown. `hoursRemaining` is negative once the fuse has burned, and rendering it would
    // read as "-24 hour(s) from now" — a sentence that tells the owner nothing about what to do.
    expect(html).not.toContain('hour(s) from')
  })
})

describe('renderConnectionHealth', () => {
  const health = deriveConnectionHealth(
    {
      status: 'active',
      consentAt: CONSENT,
      lastOkAt: at(-2 * 60 * 60 * 1000),
      grantedScopes: [],
      capabilities: [],
      consentScreenInTesting: true,
      gbpAccessGranted: true,
    },
    at(0),
  )

  it('states the recency beside the state, because Connected with no recency hides failure', () => {
    const html = renderConnectionHealth([
      {
        connectionId: 'conn-1',
        googleEmail: 'google-admin@berelax.ae',
        health,
        expiry: testingExpiryFor({ publishingStatus: 'testing', consentAt: CONSENT, now: at(0) }),
      },
    ])
    expect(html).toContain('data-connection-recency="2"')
    expect(html).toContain('Last verified 2 hour(s) ago')
    expect(html).toContain(`data-tripwire="${TESTING_EXPIRY_TRIPWIRE}"`)
  })

  it('says so explicitly when nothing has ever succeeded', () => {
    const never = deriveConnectionHealth(
      {
        status: 'active',
        consentAt: CONSENT,
        lastOkAt: null,
        grantedScopes: [],
        capabilities: [],
        consentScreenInTesting: false,
        gbpAccessGranted: true,
      },
      at(0),
    )
    const html = renderConnectionHealth([
      { connectionId: 'conn-1', googleEmail: 'a@b.ae', health: never, expiry: null },
    ])
    expect(html).toContain('data-connection-recency="never"')
    expect(html).toContain('No successful call has been made yet')
  })

  it('renders no scope URL anywhere, in any state', () => {
    // docs/10 §4: plain English, never a scope string. Asserted over every presentation state rather
    // than over one, so a sentence added later cannot quietly paste one in.
    for (const state of [
      'never_connected',
      'healthy',
      'expiring_soon',
      'degraded',
      'broken',
      'pending_gbp_approval',
    ] as const) {
      const html = renderConnectionHealth([
        {
          connectionId: 'c',
          googleEmail: 'a@b.ae',
          health: { ...health, displayState: state },
          expiry: null,
        },
      ])
      expect(html, state).not.toContain('googleapis.com/auth/')
    }
  })

  it('escapes a listing or account name that carries markup', () => {
    const html = renderConnectionHealth([
      {
        connectionId: 'c',
        googleEmail: '<script>alert(1)</script>@b.ae',
        health,
        expiry: null,
      },
    ])
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('has something to say when no connection exists at all', () => {
    expect(renderConnectionHealth([])).toContain('data-google-connections="0"')
  })
})

describe('isGooglePublishingStatus', () => {
  it('accepts the two statuses and refuses anything else', () => {
    for (const status of GOOGLE_PUBLISHING_STATUSES)
      expect(isGooglePublishingStatus(status)).toBe(true)
    // `internal` is the plausible wrong answer: it is a real thing in Google's console (an audience) and
    // is not a publishing status. Coercing it would coerce it to `production`, which is the value that
    // silences the tripwire.
    for (const wrong of ['internal', 'Testing', '', null, undefined, 1, true]) {
      expect(isGooglePublishingStatus(wrong), String(wrong)).toBe(false)
    }
  })
})

describe('spellDate and escapeHtml', () => {
  it('spells a date the way a person in Abu Dhabi reads it', () => {
    expect(spellDate('2026-01-05' as never)).toBe('5 January 2026')
    expect(spellDate('2026-12-31' as never)).toBe('31 December 2026')
  })

  it('escapes the five characters and leaves the rest readable', () => {
    expect(escapeHtml('BE RELAX — "Massage" & Spa <Al Zahiyah>')).toBe(
      'BE RELAX — &quot;Massage&quot; &amp; Spa &lt;Al Zahiyah&gt;',
    )
  })
})

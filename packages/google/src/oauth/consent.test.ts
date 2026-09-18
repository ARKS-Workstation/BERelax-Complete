import { createHash } from 'node:crypto'
import {
  fixedClock,
  GOOGLE_SCOPE_BUSINESS_MANAGE,
  GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY,
  type GoogleRequestedScope,
  instantFromIso,
  REQUESTED_GOOGLE_SCOPES,
} from '@berelax/core'
import { createCallLog } from '@berelax/providers/call-log'
import { FailureScript } from '@berelax/providers/failure'
import { createFakeGoogleOAuth } from '@berelax/providers/google'
import { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import {
  buildAuthorizationRequest,
  CONSENT_WINDOW_MINUTES,
  type ConsentDeps,
  codeChallengeFor,
  consentWindowExpired,
  parsePendingConsent,
  serialisePendingConsent,
} from './consent.ts'

/**
 * The authorization request, and the one claim about it that is worth a test: **what it asks for.**
 *
 * The consent screen is the only moment the owner decides what this system may do to their Google
 * presence. Everything after it is a consequence, so a scope that should not be on it is not a cosmetic
 * defect — `business.manage` alone can rewrite the address and the opening hours.
 */
const NOW_ISO = '2026-09-18T10:00:00.000Z'
const NOW = instantFromIso(NOW_ISO)

/** Deterministic bytes, so the state and the challenge can be asserted exactly. */
const countingBytes = (): ((size: number) => Buffer) => {
  let call = 0
  return (size) => {
    call += 1
    return Buffer.alloc(size, call)
  }
}

function deps(): ConsentDeps {
  return {
    oauth: createFakeGoogleOAuth({
      log: createCallLog(() => NOW_ISO),
      failures: new FailureScript(),
      now: () => NOW_ISO,
    }),
    clock: fixedClock(NOW_ISO),
    randomBytes: countingBytes(),
  }
}

/** The `scope` parameter, split the way Google splits it: whole scopes, space-separated. */
function scopesInUrl(url: string): readonly string[] {
  const query = url.slice(url.indexOf('?') + 1)
  const scope = new URLSearchParams(query).get('scope')
  return scope === null ? [] : scope.split(' ')
}

describe('the requested scopes', () => {
  it('asks for exactly business.manage and webmasters.readonly', () => {
    const { url } = buildAuthorizationRequest(deps())
    expect([...scopesInUrl(url)].sort()).toEqual(
      [GOOGLE_SCOPE_BUSINESS_MANAGE, GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY].sort(),
    )
    expect(REQUESTED_GOOGLE_SCOPES).toHaveLength(2)
  })

  it('never carries the read-write webmasters scope, a Gmail scope or a GA4 scope', () => {
    const scopes = scopesInUrl(buildAuthorizationRequest(deps()).url)
    for (const forbidden of [
      'https://www.googleapis.com/auth/webmasters',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://mail.google.com/',
      'https://www.googleapis.com/auth/analytics.readonly',
    ]) {
      expect(scopes).not.toContain(forbidden)
    }
    // The control. Comparing whole scopes is the only way this assertion means anything: the read-only
    // Search Console scope CONTAINS the forbidden read-write one as a prefix, so a substring test over
    // the raw URL would fail on a correct request — and would then be deleted.
    const raw = buildAuthorizationRequest(deps()).url
    expect(decodeURIComponent(raw)).toContain('https://www.googleapis.com/auth/webmasters')
    expect(scopes).toContain(GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY)
  })

  it('refuses a forbidden scope at runtime as well as at compile time', () => {
    // The type makes this unreachable from well-typed code. It is still reachable from a scope list that
    // arrived as data — configuration, a request body — where no compiler was present.
    const smuggled = [
      'https://www.googleapis.com/auth/gmail.readonly',
    ] as unknown as readonly GoogleRequestedScope[]
    expect(() => buildAuthorizationRequest(deps(), { scopes: smuggled })).toThrow(AppError)
    expect(() => buildAuthorizationRequest(deps(), { scopes: smuggled })).toThrow(/gmail\.readonly/)
  })

  it('refuses an empty scope list rather than asking for nothing', () => {
    expect(() => buildAuthorizationRequest(deps(), { scopes: [] })).toThrow(/no scopes/)
  })

  it('lets a re-consent narrow to one scope', () => {
    const { url } = buildAuthorizationRequest(deps(), {
      scopes: [GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY],
    })
    expect(scopesInUrl(url)).toEqual([GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY])
  })
})

describe('state and PKCE', () => {
  it('sends an S256 challenge that is the hash of the verifier it kept', () => {
    const { url, pending } = buildAuthorizationRequest(deps())
    const params = new URLSearchParams(url.slice(url.indexOf('?') + 1))
    expect(params.get('code_challenge_method')).toBe('S256')
    expect(params.get('code_challenge')).toBe(pending.codeChallenge)
    expect(pending.codeChallenge).toBe(
      createHash('sha256').update(pending.codeVerifier, 'ascii').digest('base64url'),
    )
    // The control: the challenge must not be the verifier itself, which is the plain method PKCE
    // deprecated and which a careless implementation produces.
    expect(pending.codeChallenge).not.toBe(pending.codeVerifier)
  })

  it('base64url-encodes both, so neither needs escaping in a query string', () => {
    const { pending } = buildAuthorizationRequest(deps())
    for (const value of [pending.state, pending.codeVerifier, pending.codeChallenge]) {
      expect(value).toMatch(/^[A-Za-z0-9_-]+$/)
    }
    // RFC 7636's minimum verifier length. 32 random bytes encode to 43 characters.
    expect(pending.codeVerifier.length).toBeGreaterThanOrEqual(43)
  })

  it('uses a different state and verifier on every request', () => {
    // The randomness is injected here, so this asserts the builder draws fresh bytes rather than that
    // the OS entropy works. A builder that reused one state would let one intercepted callback be
    // replayed against every later consent.
    const shared = deps()
    const first = buildAuthorizationRequest(shared)
    const second = buildAuthorizationRequest(shared)
    expect(first.pending.state).not.toBe(second.pending.state)
    expect(first.pending.codeVerifier).not.toBe(second.pending.codeVerifier)
  })

  it('puts the state in the URL, because the callback is compared against it', () => {
    const { url, pending } = buildAuthorizationRequest(deps())
    expect(new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('state')).toBe(pending.state)
  })

  it('asks for offline access and a forced consent, or no refresh token comes back', () => {
    const params = new URLSearchParams(buildAuthorizationRequest(deps()).url.split('?')[1] ?? '')
    expect(params.get('access_type')).toBe('offline')
    expect(params.get('prompt')).toBe('consent')
  })

  it('computes the challenge for a known verifier the way RFC 7636 does', () => {
    // The RFC's own example, so the implementation is checked against the specification rather than
    // against itself.
    expect(codeChallengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    )
  })
})

describe('the consent window', () => {
  it('is open inside ten minutes and closed after', () => {
    const { pending } = buildAuthorizationRequest(deps())
    const minutes = (n: number) => (NOW + n * 60_000) as typeof NOW
    expect(consentWindowExpired(pending, minutes(CONSENT_WINDOW_MINUTES))).toBe(false)
    expect(consentWindowExpired(pending, minutes(CONSENT_WINDOW_MINUTES + 1))).toBe(true)
  })
})

describe('the cookie payload', () => {
  it('round-trips a pending consent', () => {
    const { pending } = buildAuthorizationRequest(deps(), {
      reconnectingConnectionId: 'connection-1',
    })
    expect(parsePendingConsent(serialisePendingConsent(pending))).toEqual(pending)
  })

  it('refuses an absent, unparseable or incomplete cookie with one reason', () => {
    for (const raw of [
      null,
      undefined,
      '',
      'not json',
      '{}',
      JSON.stringify({ state: 's', codeVerifier: 'v' }),
    ]) {
      expect(() => parsePendingConsent(raw)).toThrow(AppError)
      try {
        parsePendingConsent(raw)
      } catch (error) {
        expect((error as AppError).details['reason']).toBe('google_consent_cookie_missing')
      }
    }
  })
})

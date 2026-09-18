import {
  fixedClock,
  GOOGLE_SCOPE_BUSINESS_MANAGE,
  GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY,
  instantFromIso,
} from '@berelax/core'
import { createCallLog } from '@berelax/providers/call-log'
import { FailureScript } from '@berelax/providers/failure'
import { createFakeGoogleOAuth, type GoogleTokens } from '@berelax/providers/google'
import { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { buildAuthorizationRequest, type ConsentDeps } from './consent.ts'
import {
  authorizationCodeFingerprint,
  CONSENT_CODE_REPLAYED,
  CONSENT_DENIED,
  CONSENT_IDENTITY_MISMATCH,
  CONSENT_STATE_MISMATCH,
  CONSENT_WINDOW_CLOSED,
  claimsFromIdToken,
  consentCodeReplayed,
  exchangeConsentCode,
  identityFrom,
} from './exchange.ts'

/**
 * The callback, and the four ways it is refused.
 *
 * Every refusal in `exchange.ts` happens before a store exists, which is the design: *"neither path
 * writes a connection row"* is true because there is nothing in scope to write to. The tests here prove
 * each refusal fires and carries a **distinct** reason — a state mismatch and a replayed code look the
 * same to a cleared cookie, and an operator who cannot tell them apart cannot tell a hostile callback
 * from a reloaded tab.
 */
const NOW_ISO = '2026-09-18T10:00:00.000Z'
const SUB = 'sub-owner-0001'
const EMAIL = 'google-admin@berelax.ae'

function fakeOAuth(overrides: { sub?: string; email?: string; grantedScopes?: string[] } = {}) {
  return createFakeGoogleOAuth({
    log: createCallLog(() => NOW_ISO),
    failures: new FailureScript(),
    now: () => NOW_ISO,
    sub: overrides.sub ?? SUB,
    email: overrides.email ?? EMAIL,
    ...(overrides.grantedScopes === undefined ? {} : { grantedScopes: overrides.grantedScopes }),
  })
}

function consentDeps(oauth = fakeOAuth()): ConsentDeps {
  return { oauth, clock: fixedClock(NOW_ISO) }
}

/**
 * Walks the fake consent screen and returns what the browser would come back with.
 *
 * `dev_code` is the fake's stand-in for the code a real consent server mints, which is what lets it
 * enforce PKCE and single use the way Google does.
 */
function walkConsent(deps: ConsentDeps, args: { reconnectingConnectionId?: string | null } = {}) {
  const request = buildAuthorizationRequest(deps, args)
  const params = new URLSearchParams(request.url.slice(request.url.indexOf('?') + 1))
  const code = params.get('dev_code')
  if (code === null) throw new Error('the fake consent screen minted no code')
  return { pending: request.pending, callback: { code, state: request.pending.state } }
}

describe('a successful exchange', () => {
  it('returns the granted scopes, the identity from the id_token and a code fingerprint', async () => {
    const deps = consentDeps()
    const { pending, callback } = walkConsent(deps)
    const grant = await exchangeConsentCode(deps, pending, callback)

    expect(grant.identity).toEqual({ googleSub: SUB, googleEmail: EMAIL })
    expect(grant.grantedScopes).toContain(GOOGLE_SCOPE_BUSINESS_MANAGE)
    expect(grant.grantedScopes).toContain(GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY)
    expect(grant.refreshToken).not.toBe('')
    expect(grant.accessExpiresAt).toBeGreaterThan(instantFromIso(NOW_ISO))
    // A hash, never the code. 64 hex characters, and not the code itself.
    expect(grant.authorizationCodeFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(grant.authorizationCodeFingerprint).not.toContain(callback.code)
    expect(grant.authorizationCodeFingerprint).toBe(authorizationCodeFingerprint(callback.code))
  })

  it('stores what Google granted, not what was requested', async () => {
    // The owner unticked Business Profile on the consent screen. The exchange still succeeds.
    const oauth = fakeOAuth({
      grantedScopes: ['openid', 'email', GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY],
    })
    const deps = consentDeps(oauth)
    const { pending, callback } = walkConsent(deps)
    const grant = await exchangeConsentCode(deps, pending, callback)

    expect(grant.grantedScopes).not.toContain(GOOGLE_SCOPE_BUSINESS_MANAGE)
    // The control: the request did ask for it, so a flow that stored the request would disagree here.
    expect(pending.scopes).toContain(GOOGLE_SCOPE_BUSINESS_MANAGE)
  })
})

describe('the refusals', () => {
  const reasonOf = async (run: () => Promise<unknown>): Promise<unknown> => {
    try {
      await run()
    } catch (error) {
      expect(error).toBeInstanceOf(AppError)
      return (error as AppError).details['reason']
    }
    throw new Error('expected a refusal')
  }

  it('rejects a state that does not match the consent this server started', async () => {
    const deps = consentDeps()
    const { pending, callback } = walkConsent(deps)
    expect(
      await reasonOf(() =>
        exchangeConsentCode(deps, pending, { ...callback, state: 'someone-elses-state' }),
      ),
    ).toBe(CONSENT_STATE_MISMATCH)
    // And an absent state, which is the same refusal: telling a caller which of the two it was tells an
    // attacker whether the guess had the right shape.
    expect(await reasonOf(() => exchangeConsentCode(deps, pending, { code: callback.code }))).toBe(
      CONSENT_STATE_MISMATCH,
    )
    // The control: the same callback with the right state succeeds, so the refusal is the state and not
    // something else about the request.
    await expect(exchangeConsentCode(deps, pending, callback)).resolves.toBeDefined()
  })

  it('rejects a callback that carries Google refusal instead of a code', async () => {
    const deps = consentDeps()
    const { pending } = walkConsent(deps)
    expect(
      await reasonOf(() =>
        exchangeConsentCode(deps, pending, {
          state: pending.state,
          error: 'admin_policy_enforced',
        }),
      ),
    ).toBe(CONSENT_DENIED)
    expect(await reasonOf(() => exchangeConsentCode(deps, pending, { state: pending.state }))).toBe(
      CONSENT_DENIED,
    )
  })

  it('rejects a consent completed after the window closed', async () => {
    const deps = consentDeps()
    const { pending, callback } = walkConsent(deps)
    const late = { ...deps, clock: fixedClock('2026-09-18T10:11:00.000Z') }
    expect(await reasonOf(() => exchangeConsentCode(late, pending, callback))).toBe(
      CONSENT_WINDOW_CLOSED,
    )
  })

  it('rejects a code whose PKCE verifier does not match the challenge it was issued against', async () => {
    const deps = consentDeps()
    const { pending, callback } = walkConsent(deps)
    const tampered = { ...pending, codeVerifier: 'a'.repeat(43) }
    await expect(exchangeConsentCode(deps, tampered, callback)).rejects.toThrow(/invalid_grant/)
    // The control: the untampered verifier is accepted, so the rejection is PKCE and not the code.
    await expect(exchangeConsentCode(deps, pending, callback)).resolves.toBeDefined()
  })

  it('rejects the second exchange of the same code at the provider too', async () => {
    const deps = consentDeps()
    const { pending, callback } = walkConsent(deps)
    await expect(exchangeConsentCode(deps, pending, callback)).resolves.toBeDefined()
    await expect(exchangeConsentCode(deps, pending, callback)).rejects.toThrow(/invalid_grant/)
  })

  it('names a replayed code distinctly from every other refusal', () => {
    const error = consentCodeReplayed()
    expect(error.details['reason']).toBe(CONSENT_CODE_REPLAYED)
    expect(error.kind).toBe('conflict')
    // The whole point of the distinction: it is not the state-mismatch reason, which is what a cleared
    // cookie would otherwise report for a reloaded callback tab.
    expect(error.details['reason']).not.toBe(CONSENT_STATE_MISMATCH)
  })
})

describe('the identity inside the id_token', () => {
  const tokens = (overrides: Partial<GoogleTokens>): GoogleTokens => ({
    accessToken: 'fake-access',
    expiresAtIso: NOW_ISO,
    scopes: ['openid', 'email'],
    sub: SUB,
    ...overrides,
  })

  const jwt = (claims: Record<string, unknown>): string =>
    `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString(
      'base64url',
    )}.sig`

  it('reads sub and email out of the payload segment', () => {
    expect(claimsFromIdToken(jwt({ sub: SUB, email: EMAIL }))).toEqual({ sub: SUB, email: EMAIL })
    expect(identityFrom(tokens({ idToken: jwt({ sub: SUB, email: EMAIL }) }))).toEqual({
      googleSub: SUB,
      googleEmail: EMAIL,
    })
  })

  it('refuses a response with no id_token, because the account would have no email', () => {
    expect(() => identityFrom(tokens({}))).toThrow(/no id_token/)
  })

  it('refuses an id_token that is not a JWT or whose payload is not JSON', () => {
    expect(() => claimsFromIdToken('not-a-jwt')).toThrow(/no payload segment/)
    expect(() => claimsFromIdToken('header..sig')).toThrow(/no payload segment/)
    expect(() => claimsFromIdToken(`header.${Buffer.from('{').toString('base64url')}.sig`)).toThrow(
      /not decodable JSON/,
    )
  })

  it('refuses an id_token missing either claim', () => {
    for (const claims of [{ sub: SUB }, { email: EMAIL }, {}]) {
      expect(() => identityFrom(tokens({ idToken: jwt(claims) }))).toThrow(/no sub or no email/)
    }
  })

  it('refuses a response whose two subs disagree rather than picking one', () => {
    // Unreachable through a well-behaved provider, and that is exactly why it is asserted: a token
    // sealed against the wrong sub either cannot be decrypted or — worse — can be, and then a review
    // reply reaches another business.
    let thrown: unknown
    try {
      identityFrom(tokens({ sub: 'sub-a', idToken: jwt({ sub: 'sub-b', email: EMAIL }) }))
    } catch (error) {
      thrown = error
    }
    expect((thrown as AppError).kind).toBe('invariant_violated')
    expect((thrown as AppError).details['reason']).toBe(CONSENT_IDENTITY_MISMATCH)
    // The control: the same call with agreeing subs returns rather than throws.
    expect(
      identityFrom(tokens({ sub: 'sub-a', idToken: jwt({ sub: 'sub-a', email: EMAIL }) })),
    ).toEqual({ googleSub: 'sub-a', googleEmail: EMAIL })
  })

  it('refuses a grant that came back without a refresh token', async () => {
    // Google omits it when the account already granted this client and `prompt=consent` was absent. A
    // connection stored from such a response works for one hour and then has nothing to refresh from.
    const deps = consentDeps()
    const { pending, callback } = walkConsent(deps)
    const noRefresh = {
      ...deps,
      oauth: {
        ...deps.oauth,
        async exchangeCode() {
          const full = await fakeOAuth().exchangeCode('code')
          const { refreshToken, ...rest } = full
          void refreshToken
          return rest
        },
      },
    }
    await expect(exchangeConsentCode(noRefresh, pending, callback)).rejects.toThrow(
      /no refresh token/,
    )
  })
})

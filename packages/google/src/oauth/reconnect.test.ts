import { generateKek } from '@berelax/clinical'
import {
  deriveConnectionHealth,
  fixedClock,
  GOOGLE_SCOPE_BUSINESS_MANAGE,
  GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY,
  instantFromIso,
  missingScopesFor,
} from '@berelax/core'
import { createCallLog } from '@berelax/providers/call-log'
import { FailureScript } from '@berelax/providers/failure'
import { createFakeGoogleOAuth } from '@berelax/providers/google'
import { AppError } from '@berelax/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import { connectionRecord, createMemoryConnectionStore } from '../memory-store.ts'
import { connectionBinding, sealToken } from '../token-store.ts'
import { buildAuthorizationRequest, type ConsentDeps } from './consent.ts'
import { type ConsentGrant, exchangeConsentCode } from './exchange.ts'
import { applyConsent } from './reconnect.ts'

/**
 * The sub-match semantics, against the fake and a store that reproduces the database's constraints.
 *
 * The claim under test is the one in docs/10 §5: a matching `google_sub` is a re-auth of an existing
 * connection, a different one is a second Google account. The reason it is worth this much test is that
 * getting it wrong is silent — the wrong branch produces a connected-looking system whose review
 * replies go to a listing nobody chose.
 */
const NOW_ISO = '2026-09-18T10:00:00.000Z'
const LATER_ISO = '2026-09-19T09:00:00.000Z'
const KEK = generateKek('v1')
const OWNER_SUB = 'sub-owner-0001'
const OWNER_EMAIL = 'google-admin@berelax.ae'
const AGENCY_SUB = 'sub-agency-0002'
const AGENCY_EMAIL = 'webmaster@example.com'
const PLACE_ID = 'ChIJ-fixture-place-id'
const BOTH_SCOPES = [
  'openid',
  'email',
  GOOGLE_SCOPE_BUSINESS_MANAGE,
  GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY,
]

function oauthFor(args: { sub: string; email: string; grantedScopes?: readonly string[] }) {
  return createFakeGoogleOAuth({
    log: createCallLog(() => NOW_ISO),
    failures: new FailureScript(),
    now: () => NOW_ISO,
    sub: args.sub,
    email: args.email,
    ...(args.grantedScopes === undefined ? {} : { grantedScopes: args.grantedScopes }),
  })
}

/** Walks the fake consent screen and exchanges, which is how a `ConsentGrant` is obtained for real. */
async function grantFor(args: {
  readonly sub: string
  readonly email: string
  readonly grantedScopes?: readonly string[]
  readonly at?: string
}): Promise<ConsentGrant> {
  const deps: ConsentDeps = {
    oauth: oauthFor(args),
    clock: fixedClock(args.at ?? NOW_ISO),
  }
  const request = buildAuthorizationRequest(deps)
  const params = new URLSearchParams(request.url.slice(request.url.indexOf('?') + 1))
  const code = params.get('dev_code')
  if (code === null) throw new Error('the fake consent screen minted no code')
  return exchangeConsentCode(deps, request.pending, { code, state: request.pending.state })
}

let store: ReturnType<typeof createMemoryConnectionStore>

beforeEach(() => {
  store = createMemoryConnectionStore()
})

const deps = (at = NOW_ISO) => ({ kek: KEK, clock: fixedClock(at) })

/** An already-connected owner, with the location selection a later unit records. */
async function seedOwnerConnection(grantedScopes: readonly string[] = BOTH_SCOPES) {
  const id = await store.allocateId()
  store.put(
    connectionRecord({
      id,
      googleSub: OWNER_SUB,
      googleEmail: OWNER_EMAIL,
      grantedScopes,
      refreshToken: sealToken(
        KEK,
        connectionBinding({ connectionId: id, googleSub: OWNER_SUB }),
        'seeded-refresh-token',
      ),
      consentAt: instantFromIso('2026-09-10T08:00:00.000Z'),
      lastOkAt: instantFromIso('2026-09-18T09:00:00.000Z'),
    }),
  )
  store.putCapability({
    connectionId: id,
    capability: 'gbp_reviews',
    resourceRef: { placeId: PLACE_ID },
    health: 'ok',
    isPrimary: true,
  })
  store.putCapability({
    connectionId: id,
    capability: 'gsc',
    resourceRef: { siteUrl: 'https://berelax.example/' },
    health: 'ok',
    isPrimary: true,
  })
  return id
}

describe('the first connection', () => {
  it('inserts one row and a capability row per capability, with no warning', async () => {
    const grant = await grantFor({ sub: OWNER_SUB, email: OWNER_EMAIL })
    const outcome = await applyConsent(store, deps(), grant)

    expect(outcome.kind).toBe('connected')
    expect(outcome.warning).toBeNull()
    expect(store.records()).toHaveLength(1)
    expect(outcome.capabilities.map((c) => c.capability).sort()).toEqual([
      'gbp_location',
      'gbp_performance',
      'gbp_reviews',
      'gsc',
    ])
    // Unknown, not ok: consent proves the scope, never the resource behind it.
    expect([...new Set(outcome.capabilities.map((c) => c.health))]).toEqual(['unknown'])
    expect(store.events().map((e) => e.event)).toEqual(['connected'])
  })

  it('records the code fingerprint on the event and never the code', async () => {
    const grant = await grantFor({ sub: OWNER_SUB, email: OWNER_EMAIL })
    await applyConsent(store, deps(), grant)
    const [event] = store.events()
    expect(event?.detail?.['authorizationCodeFingerprint']).toBe(grant.authorizationCodeFingerprint)
    expect(JSON.stringify(event)).not.toContain(grant.refreshToken)
  })
})

describe('granted scopes are Google truth, not our request', () => {
  it('stores the one scope granted, marks gbp permission_missing and leaves gsc usable', async () => {
    const grant = await grantFor({
      sub: OWNER_SUB,
      email: OWNER_EMAIL,
      grantedScopes: ['openid', 'email', GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY],
    })
    const outcome = await applyConsent(store, deps(), grant)

    expect(outcome.grantedScopes).not.toContain(GOOGLE_SCOPE_BUSINESS_MANAGE)
    const health = new Map(outcome.capabilities.map((c) => [c.capability, c.health]))
    expect(health.get('gbp_reviews')).toBe('permission_missing')
    expect(health.get('gbp_location')).toBe('permission_missing')
    expect(health.get('gsc')).toBe('unknown')

    // "The connection stays usable for gsc" made concrete: the grant is active, Search Console needs no
    // scope it does not have, and the display state is not `broken`.
    const record = await store.loadBySub(OWNER_SUB)
    expect(record?.status).toBe('active')
    expect(missingScopesFor(['gsc'], outcome.grantedScopes)).toEqual([])
    // The control: the same question for gbp_reviews must come back non-empty, or the assertion above
    // would pass for a connection that can do nothing at all.
    expect(missingScopesFor(['gbp_reviews'], outcome.grantedScopes)).toEqual([
      GOOGLE_SCOPE_BUSINESS_MANAGE,
    ])
    expect(
      deriveConnectionHealth(
        {
          status: 'active',
          consentAt: instantFromIso(NOW_ISO),
          lastOkAt: null,
          grantedScopes: outcome.grantedScopes,
          capabilities: outcome.capabilities.map((c) => ({
            capability: c.capability,
            health: c.health,
          })),
          consentScreenInTesting: false,
          gbpAccessGranted: false,
        },
        instantFromIso(NOW_ISO),
      ).displayState,
    ).not.toBe('broken')
  })
})

describe('reconnect with a matching sub', () => {
  it('updates in place: the same row id, the same capability rows, the same placeId', async () => {
    const id = await seedOwnerConnection()
    const before = await store.capabilitiesFor(id)

    const grant = await grantFor({ sub: OWNER_SUB, email: OWNER_EMAIL, at: LATER_ISO })
    const outcome = await applyConsent(store, deps(LATER_ISO), grant)

    expect(outcome.kind).toBe('reconnected')
    expect(outcome.connectionId).toBe(id)
    expect(store.records()).toHaveLength(1)

    // Every seeded capability row survives with its resource and its health. Rows for the capabilities
    // that had none are added, which is a different claim tested below — so this asserts identity of the
    // seeded rows rather than the length of the set.
    const after = await store.capabilitiesFor(id)
    for (const seeded of before) {
      const match = after.find(
        (c) =>
          c.capability === seeded.capability &&
          JSON.stringify(c.resourceRef) === JSON.stringify(seeded.resourceRef),
      )
      expect(match, `${seeded.capability} lost its resource`).toEqual(seeded)
    }
    expect(after.find((c) => c.capability === 'gbp_reviews')?.resourceRef).toEqual({
      placeId: PLACE_ID,
    })
    // An observed `ok` survives a re-consent: re-consenting is not evidence the resource still works,
    // and it is not evidence it stopped either.
    expect(before.every((c) => c.health === 'ok')).toBe(true)
    expect(store.events().map((e) => e.event)).toEqual(['reconnected'])
  })

  it('replaces the stored refresh token and clears the cached access token', async () => {
    const id = await seedOwnerConnection()
    const seeded = await store.load(id)
    const grant = await grantFor({ sub: OWNER_SUB, email: OWNER_EMAIL, at: LATER_ISO })
    await applyConsent(store, deps(LATER_ISO), grant)

    const record = await store.load(id)
    expect(record?.refreshToken.ct.equals(seeded?.refreshToken.ct as Buffer)).toBe(false)
    // The old access token carried the OLD scope set and would keep working for up to an hour against a
    // product the owner may have just removed.
    expect(record?.accessToken).toBeNull()
    expect(record?.accessExpiresAt).toBeNull()
    expect(record?.consentAt).toBe(instantFromIso(LATER_ISO))
  })

  it('records scopes_changed when the new grant is narrower, and reports what went', async () => {
    const id = await seedOwnerConnection()
    const grant = await grantFor({
      sub: OWNER_SUB,
      email: OWNER_EMAIL,
      grantedScopes: ['openid', 'email', GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY],
      at: LATER_ISO,
    })
    const outcome = await applyConsent(store, deps(LATER_ISO), grant)

    expect(outcome.removedScopes).toEqual([GOOGLE_SCOPE_BUSINESS_MANAGE])
    expect(store.events().map((e) => e.event)).toEqual(['reconnected', 'scopes_changed'])
    const after = await store.capabilitiesFor(id)
    expect(after.find((c) => c.capability === 'gbp_reviews')?.health).toBe('permission_missing')
    // …and the resource is still there, so re-granting the scope later does not cost the selection.
    expect(after.find((c) => c.capability === 'gbp_reviews')?.resourceRef).toEqual({
      placeId: PLACE_ID,
    })
  })

  it('adds a capability row for a product the previous grant did not cover', async () => {
    const id = await seedOwnerConnection()
    // Seeded with two capability rows; the other two Business Profile capabilities have none.
    const grant = await grantFor({ sub: OWNER_SUB, email: OWNER_EMAIL, at: LATER_ISO })
    const outcome = await applyConsent(store, deps(LATER_ISO), grant)
    expect(outcome.capabilities).toHaveLength(4)
    expect(
      outcome.capabilities
        .filter((c) => c.resourceRef === null)
        .map((c) => c.capability)
        .sort(),
    ).toEqual(['gbp_location', 'gbp_performance'])
    expect((await store.capabilitiesFor(id)).length).toBe(4)
  })
})

describe('reconnect with a different sub', () => {
  it('inserts a second row and warns, naming both email addresses', async () => {
    const id = await seedOwnerConnection()
    const grant = await grantFor({ sub: AGENCY_SUB, email: AGENCY_EMAIL, at: LATER_ISO })
    const outcome = await applyConsent(store, deps(LATER_ISO), grant, {
      reconnectingConnectionId: id,
    })

    expect(outcome.kind).toBe('additional_account')
    expect(outcome.connectionId).not.toBe(id)
    expect(store.records()).toHaveLength(2)
    expect(outcome.warning).not.toBeNull()
    expect(outcome.warning?.reason).toBe('google_account_differs')
    expect(outcome.warning?.existingEmail).toBe(OWNER_EMAIL)
    expect(outcome.warning?.newEmail).toBe(AGENCY_EMAIL)
    expect(outcome.warning?.message).toContain(OWNER_EMAIL)
    expect(outcome.warning?.message).toContain(AGENCY_EMAIL)
    expect(outcome.warning?.existingSub).toBe(OWNER_SUB)
    expect(outcome.warning?.newSub).toBe(AGENCY_SUB)
  })

  it('leaves the original row and its capabilities untouched, field by field', async () => {
    const id = await seedOwnerConnection()
    const before = await store.load(id)
    const capabilitiesBefore = await store.capabilitiesFor(id)
    if (before === null) throw new Error('seed failed')

    const grant = await grantFor({ sub: AGENCY_SUB, email: AGENCY_EMAIL, at: LATER_ISO })
    await applyConsent(store, deps(LATER_ISO), grant, { reconnectingConnectionId: id })

    const after = await store.load(id)
    if (after === null) throw new Error('the original row disappeared')
    // Field by field rather than by reference: comparing two references, or a spread of one object
    // against itself, would pass for a row that had been rewritten in place.
    const keys = Object.keys(before) as (keyof typeof before)[]
    expect(keys.length).toBeGreaterThan(9)
    for (const key of keys) {
      expect(after[key], `${key} changed`).toEqual(before[key])
    }
    expect(capabilitiesBefore).toEqual(await store.capabilitiesFor(id))
  })

  it('binds the second row to its own sub, so the same token seals to different ciphertext', async () => {
    // The control for the byte-identical claim above. The AAD is {table, recordId, google_sub}, so the
    // SAME plaintext under two different subs cannot produce the same bytes — and a ciphertext moved
    // between rows fails authentication rather than decrypting to another account's token.
    const first = sealToken(
      KEK,
      connectionBinding({ connectionId: 'connection-a', googleSub: OWNER_SUB }),
      'identical-plaintext-token',
    )
    const second = sealToken(
      KEK,
      connectionBinding({ connectionId: 'connection-a', googleSub: AGENCY_SUB }),
      'identical-plaintext-token',
    )
    expect(first.ct.equals(second.ct)).toBe(false)
    expect(first.aadFingerprint).not.toBe(second.aadFingerprint)
  })

  it('does not warn when there was nothing to replace', async () => {
    const grant = await grantFor({ sub: AGENCY_SUB, email: AGENCY_EMAIL })
    const outcome = await applyConsent(store, deps(), grant)
    expect(outcome.kind).toBe('connected')
    expect(outcome.warning).toBeNull()
  })

  it('warns against the oldest connection when the owner named none', async () => {
    await seedOwnerConnection()
    const grant = await grantFor({ sub: AGENCY_SUB, email: AGENCY_EMAIL, at: LATER_ISO })
    const outcome = await applyConsent(store, deps(LATER_ISO), grant)
    expect(outcome.warning?.existingEmail).toBe(OWNER_EMAIL)
  })
})

describe('a replayed authorization code', () => {
  it('is refused with its own reason and writes no second row', async () => {
    const grant = await grantFor({ sub: OWNER_SUB, email: OWNER_EMAIL })
    await applyConsent(store, deps(), grant)
    expect(store.records()).toHaveLength(1)

    // The same grant again — which is what a reloaded callback tab produces once our own exchange has
    // already succeeded.
    await expect(applyConsent(store, deps(), grant)).rejects.toThrow(AppError)
    await expect(applyConsent(store, deps(), grant)).rejects.toThrow(/already been exchanged/)
    expect(store.records()).toHaveLength(1)
    expect(store.events()).toHaveLength(1)
  })

  it('accepts a second, genuinely different consent for the same account', async () => {
    // The control: replay rejection must key on the code, not on "this sub already connected once", or a
    // legitimate re-auth would be refused forever.
    const first = await grantFor({ sub: OWNER_SUB, email: OWNER_EMAIL })
    await applyConsent(store, deps(), first)
    const second = await grantFor({ sub: OWNER_SUB, email: OWNER_EMAIL, at: LATER_ISO })
    expect(second.authorizationCodeFingerprint).not.toBe(first.authorizationCodeFingerprint)
    const outcome = await applyConsent(store, deps(LATER_ISO), second)
    expect(outcome.kind).toBe('reconnected')
    expect(store.records()).toHaveLength(1)
  })
})

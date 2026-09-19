import { generateKek } from '@berelax/clinical'
import { fixedClock, instantFromIso } from '@berelax/core'
import { createConnection, type Sql } from '@berelax/db'
import { createCallLog } from '@berelax/providers/call-log'
import { FailureScript } from '@berelax/providers/failure'
import { createFakeGoogleOAuth } from '@berelax/providers/google'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { accessTokenFor, assertRefreshTokenStored } from './lifecycle.ts'
import { createPostgresConnectionStore } from './postgres-store.ts'
import { rewrapRefreshTokens } from './rewrap.ts'
import { connectionBinding, openToken, sealToken } from './token-store.ts'

/**
 * G-CONN-01 — the two claims that need both the cryptography and the database.
 *
 *   1. A refresh token is not readable from the table by anyone holding a database credential.
 *   2. A KEK rotation moves every row and changes nothing else.
 *
 * Both are only meaningful against the real column types. A `bytea` round trip through the driver is
 * where an encoding mistake would turn ciphertext back into something greppable.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const KEK_V1 = generateKek('v1')
const KEK_V2 = generateKek('v2')
const NOW_ISO = '2026-09-18T10:00:00.000Z'
const CONSENT_AT = instantFromIso('2026-09-17T10:00:00.000Z')

/** Shaped like Google's, and long enough that a partial leak would still be visible. */
const TOKENS = [
  { sub: 'sub-owner-0001', email: 'owner@berelax.ae', token: '1//09-AbCdEf-owner-refresh-token' },
  { sub: 'sub-agency-002', email: 'agency@example.com', token: '1//09-GhIjKl-agency-refresh-tok' },
  { sub: 'sub-webmstr-03', email: 'web@example.com', token: '1//09-MnOpQr-webmaster-refresh-t' },
]

let sql: Sql
let store: ReturnType<typeof createPostgresConnectionStore>

beforeAll(() => {
  sql = createConnection({ url, max: 2 })
  store = createPostgresConnectionStore(sql)
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

beforeEach(async () => {
  await sql`delete from google_connections`
})

async function seedThree(): Promise<readonly { id: string; sub: string; token: string }[]> {
  const seeded: { id: string; sub: string; token: string }[] = []
  for (const fixture of TOKENS) {
    // The id comes first because the AAD binds the ciphertext to its own row — the token cannot be
    // sealed until the row it belongs to has an identity.
    const id = await store.allocateId()
    await store.insert({
      id,
      googleSub: fixture.sub,
      googleEmail: fixture.email,
      grantedScopes: ['https://www.googleapis.com/auth/business.manage'],
      refreshToken: sealToken(
        KEK_V1,
        connectionBinding({ connectionId: id, googleSub: fixture.sub }),
        fixture.token,
      ),
      consentAt: CONSENT_AT,
    })
    await store.upsertCapability({
      connectionId: id,
      capability: 'gbp_reviews',
      resourceRef: { placeId: `ChIJ-${fixture.sub}` },
      health: 'permission_missing',
      isPrimary: true,
    })
    seeded.push({ id, sub: fixture.sub, token: fixture.token })
  }
  return seeded
}

describe('acceptance — ciphertext at rest', () => {
  it('a raw SELECT of refresh_token_ct contains the token in no encoding', async () => {
    const [seeded] = await seedThree()
    if (seeded === undefined) throw new Error('seed failed')

    const [row] = await sql<{ ct: Buffer; hex: string; b64: string }[]>`
      select refresh_token_ct as ct,
             encode(refresh_token_ct, 'hex') as hex,
             encode(refresh_token_ct, 'base64') as b64
      from google_connections where id = ${seeded.id}
    `
    if (row === undefined) throw new Error('no row')

    expect(row.ct.toString('utf8')).not.toContain(seeded.token)
    expect(row.ct.toString('latin1')).not.toContain(seeded.token)
    expect(row.hex).not.toContain(Buffer.from(seeded.token, 'utf8').toString('hex'))
    expect(row.b64).not.toContain(Buffer.from(seeded.token, 'utf8').toString('base64'))

    // The control: the same assertions against the plaintext must fail, or they assert nothing.
    const plain = Buffer.from(seeded.token, 'utf8')
    expect(plain.toString('latin1')).toContain(seeded.token)
  })

  it('decrypts back to the exact token through the driver round trip', async () => {
    const [seeded] = await seedThree()
    if (seeded === undefined) throw new Error('seed failed')
    const record = await store.load(seeded.id)
    if (record === null) throw new Error('no record')
    expect(
      openToken(
        KEK_V1,
        connectionBinding({ connectionId: record.id, googleSub: record.googleSub }),
        assertRefreshTokenStored(record),
      ),
    ).toBe(seeded.token)
  })
})

describe('acceptance — the re-wrap job', () => {
  it('moves three rows from kid v1 to v2, leaving status and capabilities untouched', async () => {
    const seeded = await seedThree()
    // Two of the three are broken. A rotation that quietly cleared that would hide a dead connection
    // behind a key change, which is worse than the key never rotating.
    for (const row of seeded.slice(1)) {
      await store.recordStatus({
        connectionId: row.id,
        status: 'needs_reauth',
        statusReason: 'invalid_grant',
        lastCheckedAt: instantFromIso(NOW_ISO),
      })
    }

    const report = await rewrapRefreshTokens({ store, oldKek: KEK_V1, newKek: KEK_V2 })
    expect(report).toEqual({ scanned: 3, rewrapped: 3, alreadyCurrent: 0, zeroised: 0 })

    for (const row of seeded) {
      const record = await store.load(row.id)
      if (record === null) throw new Error(`missing ${row.id}`)
      expect(assertRefreshTokenStored(record).kid).toBe('v2')
      // Round-trip: the identical plaintext, under the new key.
      expect(
        openToken(
          KEK_V2,
          connectionBinding({ connectionId: record.id, googleSub: record.googleSub }),
          assertRefreshTokenStored(record),
        ),
      ).toBe(row.token)

      const capabilities = await store.capabilitiesFor(row.id)
      expect(capabilities).toHaveLength(1)
      expect(capabilities[0]?.health).toBe('permission_missing')
      expect(capabilities[0]?.resourceRef).toEqual({ placeId: `ChIJ-${row.sub}` })
      expect(capabilities[0]?.isPrimary).toBe(true)
    }

    const statuses = (await store.listAll()).map((r) => r.status).sort()
    expect(statuses).toEqual(['active', 'needs_reauth', 'needs_reauth'])
  })

  it('writes one token_rewrapped event per row, mirrored into the audit log', async () => {
    await seedThree()
    const [before] = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_event where action = 'google_connection.token_rewrapped'
    `
    await rewrapRefreshTokens({ store, oldKek: KEK_V1, newKek: KEK_V2 })
    const [after] = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_event where action = 'google_connection.token_rewrapped'
    `
    expect(Number(after?.n ?? 0) - Number(before?.n ?? 0)).toBe(3)
  })
})

describe('the lifecycle against a real row', () => {
  it('caches the refreshed access token encrypted and records the success', async () => {
    const [seeded] = await seedThree()
    if (seeded === undefined) throw new Error('seed failed')
    const deps = {
      store,
      oauth: createFakeGoogleOAuth({
        log: createCallLog(() => NOW_ISO),
        failures: new FailureScript(),
        now: () => NOW_ISO,
        sub: seeded.sub,
      }),
      kek: KEK_V1,
      clock: fixedClock(NOW_ISO),
    }

    const grant = await accessTokenFor(deps, seeded.id)
    expect(grant.refreshed).toBe(true)

    const [row] = await sql<{ ct: Buffer; kid: string; last_ok_at: Date }[]>`
      select access_token_ct as ct, access_token_kid as kid, last_ok_at
      from google_connections where id = ${seeded.id}
    `
    expect(row?.kid).toBe('v1')
    expect(row?.ct.toString('latin1')).not.toContain(grant.accessToken)
    expect(row?.last_ok_at.toISOString()).toBe(NOW_ISO)

    // The second call is served from the cache: no round trip, same token.
    const again = await accessTokenFor(deps, seeded.id)
    expect(again.refreshed).toBe(false)
    expect(again.accessToken).toBe(grant.accessToken)
  })

  it('marks the row needs_reauth on invalid_grant and appends an event', async () => {
    const [seeded] = await seedThree()
    if (seeded === undefined) throw new Error('seed failed')
    const failures = new FailureScript().failAlways('invalid_grant')
    const deps = {
      store,
      oauth: createFakeGoogleOAuth({
        log: createCallLog(() => NOW_ISO),
        failures,
        now: () => NOW_ISO,
        sub: seeded.sub,
      }),
      kek: KEK_V1,
      clock: fixedClock(NOW_ISO),
    }

    await expect(accessTokenFor(deps, seeded.id)).rejects.toThrow(/needs re-authorising/)

    const record = await store.load(seeded.id)
    expect(record?.status).toBe('needs_reauth')
    expect(record?.statusReason).toBe('invalid_grant')

    const [event] = await sql<{ event: string; detail: Record<string, unknown> }[]>`
      select event, detail from google_connection_events
      where connection_id = ${seeded.id} order by id desc limit 1
    `
    expect(event?.event).toBe('reauth_required')
    expect(event?.detail).toEqual({ failure: 'invalid_grant', notified: 'reauth_required' })
  })
})

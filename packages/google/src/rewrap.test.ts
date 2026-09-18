import { generateKek } from '@berelax/clinical'
import { instantFromIso } from '@berelax/core'
import { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { connectionRecord, createMemoryConnectionStore } from './memory-store.ts'
import { rewrapRefreshTokens } from './rewrap.ts'
import { connectionBinding, openToken, sealToken } from './token-store.ts'

const KEK_V1 = generateKek('v1')
const KEK_V2 = generateKek('v2')
const KEK_V3 = generateKek('v3')
const CONSENT_AT = instantFromIso('2026-09-17T10:00:00.000Z')

/** Three connections, three distinct tokens, so a re-wrap that mixed rows up would be visible. */
const SEEDS = [
  { id: '01920000-0000-7000-8000-000000000001', sub: '1047', token: '1//09-token-owner' },
  { id: '01920000-0000-7000-8000-000000000002', sub: '1180', token: '1//09-token-agency' },
  { id: '01920000-0000-7000-8000-000000000003', sub: '1223', token: '1//09-token-webmaster' },
]

function seededStore(kek = KEK_V1) {
  return createMemoryConnectionStore(
    SEEDS.map((seed) =>
      connectionRecord({
        id: seed.id,
        googleSub: seed.sub,
        refreshToken: sealToken(
          kek,
          connectionBinding({ connectionId: seed.id, googleSub: seed.sub }),
          seed.token,
        ),
        consentAt: CONSENT_AT,
        status: 'needs_reauth',
        statusReason: 'invalid_grant',
      }),
    ),
  )
}

describe('the KEK rotation job', () => {
  it('moves every row from v1 to v2 and the tokens decrypt identically afterwards', async () => {
    const store = seededStore()
    const report = await rewrapRefreshTokens({ store, oldKek: KEK_V1, newKek: KEK_V2 })
    expect(report).toEqual({ scanned: 3, rewrapped: 3, alreadyCurrent: 0 })

    for (const seed of SEEDS) {
      const record = store.records().find((r) => r.id === seed.id)
      if (record === undefined) throw new Error(`missing ${seed.id}`)
      expect(record.refreshToken.kid).toBe('v2')
      expect(
        openToken(
          KEK_V2,
          connectionBinding({ connectionId: seed.id, googleSub: seed.sub }),
          record.refreshToken,
        ),
      ).toBe(seed.token)
    }
  })

  it('leaves status, reason and capabilities untouched', async () => {
    // A rotation that could clear a needs_reauth would hide a dead connection behind a key change.
    const store = seededStore()
    store.putCapability({
      connectionId: SEEDS[0]?.id ?? '',
      capability: 'gbp_reviews',
      resourceRef: { placeId: 'ChIJ-fixture' },
      health: 'permission_missing',
      isPrimary: true,
    })
    await rewrapRefreshTokens({ store, oldKek: KEK_V1, newKek: KEK_V2 })

    for (const record of store.records()) {
      expect(record.status).toBe('needs_reauth')
      expect(record.statusReason).toBe('invalid_grant')
    }
    const capabilities = await store.capabilitiesFor(SEEDS[0]?.id ?? '')
    expect(capabilities).toEqual([
      {
        connectionId: SEEDS[0]?.id,
        capability: 'gbp_reviews',
        resourceRef: { placeId: 'ChIJ-fixture' },
        health: 'permission_missing',
        isPrimary: true,
      },
    ])
  })

  it('records one token_rewrapped event per row, naming both key versions', async () => {
    const store = seededStore()
    await rewrapRefreshTokens({ store, oldKek: KEK_V1, newKek: KEK_V2 })
    const events = store.events()
    expect(events).toHaveLength(3)
    expect(events.every((e) => e.event === 'token_rewrapped')).toBe(true)
    expect(events[0]?.detail).toEqual({ fromKid: 'v1', toKid: 'v2' })
  })

  it('is a no-op on a second run, so an interrupted rotation is resumed by re-running it', async () => {
    const store = seededStore()
    await rewrapRefreshTokens({ store, oldKek: KEK_V1, newKek: KEK_V2 })
    const second = await rewrapRefreshTokens({ store, oldKek: KEK_V1, newKek: KEK_V2 })
    expect(second).toEqual({ scanned: 3, rewrapped: 0, alreadyCurrent: 3 })
    expect(store.events()).toHaveLength(3)
  })

  it('refuses a rotation to the same version', async () => {
    // Nothing would change and nothing would record that nothing changed.
    const store = seededStore()
    await expect(
      rewrapRefreshTokens({ store, oldKek: KEK_V1, newKek: generateKek('v1') }),
    ).rejects.toThrow(AppError)
  })

  it('stops loudly on a row sealed with a third, unavailable KEK', async () => {
    // The control: silently skipping it would leave one undecryptable row to be discovered by the
    // 03:00 health check, long after the retired key was discarded.
    const store = seededStore()
    const stranded = SEEDS[1]
    if (stranded === undefined) throw new Error('fixture')
    store.put(
      connectionRecord({
        id: stranded.id,
        googleSub: stranded.sub,
        refreshToken: sealToken(
          KEK_V3,
          connectionBinding({ connectionId: stranded.id, googleSub: stranded.sub }),
          stranded.token,
        ),
        consentAt: CONSENT_AT,
      }),
    )
    await expect(rewrapRefreshTokens({ store, oldKek: KEK_V1, newKek: KEK_V2 })).rejects.toThrow(
      /neither "v1" nor "v2"/,
    )
  })
})

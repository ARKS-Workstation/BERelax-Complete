import { generateKek } from '@berelax/clinical'
import { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { connectionBinding, openToken, rewrapToken, sealToken } from './token-store.ts'

const KEK_V1 = generateKek('v1')
const KEK_V2 = generateKek('v2')

const CONNECTION_ID = '01920000-0000-7000-8000-000000000001'
const OTHER_CONNECTION_ID = '01920000-0000-7000-8000-000000000002'
const SUB = '104729518362094771533'
const OTHER_SUB = '118002233445566778899'

/** Shaped like Google's: opaque, long, and useless in a log. */
const REFRESH_TOKEN = '1//09xAbCdEfGhIjKlMnOpQrStUvWxYz-0123456789_abcdefghijklmnop'

const binding = connectionBinding({ connectionId: CONNECTION_ID, googleSub: SUB })

describe('sealing a refresh token', () => {
  it('round-trips the exact token', () => {
    const sealed = sealToken(KEK_V1, binding, REFRESH_TOKEN)
    expect(openToken(KEK_V1, binding, sealed)).toBe(REFRESH_TOKEN)
  })

  it('never stores the token in a readable form', () => {
    // The acceptance criterion in three encodings. A scheme that stored the token base64-encoded would
    // pass a naive UTF-8 substring check and fail this one.
    const sealed = sealToken(KEK_V1, binding, REFRESH_TOKEN)
    expect(sealed.ct.toString('utf8')).not.toContain(REFRESH_TOKEN)
    expect(sealed.ct.toString('latin1')).not.toContain(REFRESH_TOKEN)
    expect(sealed.ct.toString('base64')).not.toContain(
      Buffer.from(REFRESH_TOKEN, 'utf8').toString('base64'),
    )
    expect(sealed.wrappedKey.toString('latin1')).not.toContain(REFRESH_TOKEN)
  })

  it('produces different ciphertext for the same token every time', () => {
    // A deterministic ciphertext would let anyone with SELECT see that two connections hold the same
    // token, and would make a stolen ciphertext replayable.
    const first = sealToken(KEK_V1, binding, REFRESH_TOKEN)
    const second = sealToken(KEK_V1, binding, REFRESH_TOKEN)
    expect(first.ct.equals(second.ct)).toBe(false)
    expect(openToken(KEK_V1, binding, second)).toBe(REFRESH_TOKEN)
  })

  it('records the KEK version so a rotation knows what to re-wrap from', () => {
    expect(sealToken(KEK_V1, binding, REFRESH_TOKEN).kid).toBe('v1')
  })

  it('refuses an empty token rather than sealing a blank', () => {
    expect(() => sealToken(KEK_V1, binding, '')).toThrow(AppError)
  })

  it('refuses a binding missing either half', () => {
    expect(() => connectionBinding({ connectionId: '', googleSub: SUB })).toThrow(AppError)
    expect(() => connectionBinding({ connectionId: CONNECTION_ID, googleSub: '' })).toThrow(
      AppError,
    )
  })
})

describe('the AAD binding', () => {
  it('refuses to decrypt a token moved to another connection row', () => {
    // The attack this stops: someone with UPDATE copies the ciphertext of the connection that owns the
    // GBP listing onto the row a consumer resolves, and replies start reaching the wrong business.
    const sealed = sealToken(KEK_V1, binding, REFRESH_TOKEN)
    const transplanted = connectionBinding({
      connectionId: OTHER_CONNECTION_ID,
      googleSub: SUB,
    })
    expect(() => openToken(KEK_V1, transplanted, sealed)).toThrow(AppError)
  })

  it('refuses to decrypt when the google_sub does not match', () => {
    const sealed = sealToken(KEK_V1, binding, REFRESH_TOKEN)
    const otherIdentity = connectionBinding({ connectionId: CONNECTION_ID, googleSub: OTHER_SUB })
    expect(() => openToken(KEK_V1, otherIdentity, sealed)).toThrow(AppError)
  })

  it('refuses to decrypt a tampered ciphertext', () => {
    const sealed = sealToken(KEK_V1, binding, REFRESH_TOKEN)
    const tampered = { ...sealed, ct: Buffer.from(sealed.ct) }
    tampered.ct[0] = (tampered.ct[0] ?? 0) ^ 0xff
    expect(() => openToken(KEK_V1, binding, tampered)).toThrow(AppError)
  })

  it('refuses to decrypt under the wrong KEK', () => {
    const sealed = sealToken(KEK_V1, binding, REFRESH_TOKEN)
    expect(() => openToken(KEK_V2, binding, sealed)).toThrow(AppError)
  })
})

describe('re-wrapping', () => {
  it('moves the kid and keeps the plaintext identical', () => {
    const sealed = sealToken(KEK_V1, binding, REFRESH_TOKEN)
    const rotated = rewrapToken(KEK_V1, KEK_V2, binding, sealed)
    expect(rotated.kid).toBe('v2')
    expect(openToken(KEK_V2, binding, rotated)).toBe(REFRESH_TOKEN)
  })

  it('leaves the payload ciphertext untouched — only the wrapped key changes', () => {
    // This is what makes rotation a background job rather than an outage: a few dozen bytes per row,
    // not a re-encryption of every token.
    const sealed = sealToken(KEK_V1, binding, REFRESH_TOKEN)
    const rotated = rewrapToken(KEK_V1, KEK_V2, binding, sealed)
    expect(rotated.ct.equals(sealed.ct)).toBe(true)
    expect(rotated.nonce.equals(sealed.nonce)).toBe(true)
    expect(rotated.wrappedKey.equals(sealed.wrappedKey)).toBe(false)
  })

  it('cannot be opened with the retired KEK afterwards', () => {
    // The control: if the old KEK still worked, nothing had actually rotated.
    const sealed = sealToken(KEK_V1, binding, REFRESH_TOKEN)
    const rotated = rewrapToken(KEK_V1, KEK_V2, binding, sealed)
    expect(() => openToken(KEK_V1, binding, rotated)).toThrow(AppError)
  })

  it('refuses to re-wrap with the wrong source KEK', () => {
    const sealed = sealToken(KEK_V1, binding, REFRESH_TOKEN)
    expect(() => rewrapToken(KEK_V2, KEK_V1, binding, sealed)).toThrow(AppError)
  })
})

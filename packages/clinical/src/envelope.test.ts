import { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import {
  fingerprint,
  generateKek,
  open,
  parseKek,
  type RecordBinding,
  rewrap,
  seal,
} from './envelope.ts'

const kek = generateKek('v1')
const binding: RecordBinding = {
  table: 'clinical.intake_submission',
  recordId: '11111111-1111-1111-1111-111111111111',
  customerId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
}
const PLAINTEXT = JSON.stringify({ pregnancy: false, medication: 'none', injuries: 'lower back' })

describe('seal and open', () => {
  it('round-trips a payload', () => {
    expect(open(kek, binding, seal(kek, binding, PLAINTEXT))).toBe(PLAINTEXT)
  })

  it('produces different ciphertext for identical plaintext, so records are not comparable', () => {
    const a = seal(kek, binding, PLAINTEXT)
    const b = seal(kek, binding, PLAINTEXT)
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false)
    expect(a.wrappedDataKey.equals(b.wrappedDataKey)).toBe(false)
  })

  it('never contains the plaintext in any stored field', () => {
    const sealed = seal(kek, binding, PLAINTEXT)
    for (const field of [sealed.ciphertext, sealed.nonce, sealed.wrappedDataKey]) {
      expect(field.toString('utf8')).not.toContain('lower back')
      expect(field.toString('latin1')).not.toContain('lower back')
    }
  })

  it('records the KEK version, so rotation is possible without losing data', () => {
    expect(seal(kek, binding, PLAINTEXT).kekVersion).toBe('v1')
  })
})

describe('tamper resistance', () => {
  it('rejects a modified ciphertext', () => {
    const sealed = seal(kek, binding, PLAINTEXT)
    const tampered = Buffer.from(sealed.ciphertext)
    tampered[0] = tampered[0] === 0 ? 1 : 0
    expect(() => open(kek, binding, { ...sealed, ciphertext: tampered })).toThrow(
      /failed authentication/,
    )
  })

  it('rejects a modified nonce', () => {
    const sealed = seal(kek, binding, PLAINTEXT)
    const nonce = Buffer.from(sealed.nonce)
    nonce[0] = nonce[0] === 0 ? 1 : 0
    expect(() => open(kek, binding, { ...sealed, nonce })).toThrow(/failed authentication/)
  })

  it('rejects a truncated ciphertext rather than returning partial data', () => {
    const sealed = seal(kek, binding, PLAINTEXT)
    expect(() =>
      open(kek, binding, { ...sealed, ciphertext: sealed.ciphertext.subarray(0, 4) }),
    ).toThrow(AppError)
  })

  it('rejects a wrong KEK', () => {
    const other = generateKek('v1') // same version, different key material
    expect(() => open(other, binding, seal(kek, binding, PLAINTEXT))).toThrow(
      /failed authentication/,
    )
  })
})

describe('AAD binding — a payload cannot be moved between customers', () => {
  it('refuses to decrypt under a different customer id', () => {
    const sealed = seal(kek, binding, PLAINTEXT)
    const otherCustomer = { ...binding, customerId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }
    // This is the attack the AAD exists to stop: someone with UPDATE swapping one client's intake
    // payload onto another client's row. Without AAD it would decrypt cleanly.
    expect(() => open(kek, otherCustomer, sealed)).toThrow(/binding does not match/)
  })

  it('refuses to decrypt under a different record id', () => {
    const sealed = seal(kek, binding, PLAINTEXT)
    expect(() =>
      open(kek, { ...binding, recordId: '22222222-2222-2222-2222-222222222222' }, sealed),
    ).toThrow(/binding does not match/)
  })

  it('refuses to decrypt under a different table', () => {
    const sealed = seal(kek, binding, PLAINTEXT)
    expect(() => open(kek, { ...binding, table: 'clinical.treatment_note' }, sealed)).toThrow(
      /binding does not match/,
    )
  })

  it('fingerprints differ for every distinct binding', () => {
    const a = fingerprint(binding)
    const b = fingerprint({ ...binding, customerId: 'other' })
    const c = fingerprint({ ...binding, recordId: 'other' })
    expect(new Set([a, b, c]).size).toBe(3)
  })

  it('detects a fingerprint that was edited to match a forged binding', () => {
    // Even if the attacker also rewrites the stored fingerprint, GCM authentication still fails,
    // because the AAD itself is part of the tag.
    const sealed = seal(kek, binding, PLAINTEXT)
    const forged = { ...binding, customerId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }
    expect(() => open(kek, forged, { ...sealed, aadFingerprint: fingerprint(forged) })).toThrow(
      /failed authentication/,
    )
  })
})

describe('key rotation', () => {
  it('re-wraps under a new KEK without decrypting the payload', () => {
    const v1 = generateKek('v1')
    const v2 = generateKek('v2')
    const sealed = seal(v1, binding, PLAINTEXT)

    const rotated = rewrap(v1, v2, binding, sealed)

    expect(rotated.kekVersion).toBe('v2')
    // The payload ciphertext is untouched: rotation moves a few dozen bytes, not every intake form.
    expect(rotated.ciphertext.equals(sealed.ciphertext)).toBe(true)
    expect(rotated.nonce.equals(sealed.nonce)).toBe(true)
    expect(open(v2, binding, rotated)).toBe(PLAINTEXT)
  })

  it('the old KEK can no longer open a rotated payload', () => {
    const v1 = generateKek('v1')
    const v2 = generateKek('v2')
    const rotated = rewrap(v1, v2, binding, seal(v1, binding, PLAINTEXT))
    expect(() => open(v1, binding, rotated)).toThrow(/sealed with KEK "v2"/)
  })

  it('refuses to re-wrap with the wrong old KEK', () => {
    const v1 = generateKek('v1')
    const wrong = generateKek('v1')
    const v2 = generateKek('v2')
    expect(() => rewrap(wrong, v2, binding, seal(v1, binding, PLAINTEXT))).toThrow(/unwrap/)
  })

  it('names the version mismatch clearly, so a retired KEK is retained rather than guessed at', () => {
    const v1 = generateKek('v1')
    const v2 = generateKek('v2')
    expect(() => open(v2, binding, seal(v1, binding, PLAINTEXT))).toThrow(
      /Retain retired KEKs until every payload has been re-wrapped/,
    )
  })
})

describe('parseKek', () => {
  it('requires exactly 32 bytes', () => {
    expect(() => parseKek(Buffer.alloc(16).toString('base64'), 'v1')).toThrow(/32 bytes/)
    expect(() => parseKek(Buffer.alloc(32).toString('base64'), 'v1')).not.toThrow()
  })

  it('requires a version, because rotation depends on it', () => {
    expect(() => parseKek(Buffer.alloc(32).toString('base64'), '')).toThrow(/version is required/)
  })
})

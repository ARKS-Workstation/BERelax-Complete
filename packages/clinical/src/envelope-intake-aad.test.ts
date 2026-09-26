import { describe, expect, it } from 'vitest'
import { fingerprint, generateKek, open, type RecordBinding, rewrap, seal } from './envelope.ts'

/**
 * The fourth AAD term (C-CRM-08, migration 0082).
 *
 * `envelope.test.ts` covers the three-term binding F08 built. This file is the term C-CRM-08 added and
 * is separate rather than appended for a practical reason as well as a tidy one: that file belongs to
 * another unit and two branches editing one region of it is a merge conflict over nothing.
 *
 * An intake payload is a map from a question set's field keys to values, so its MEANING depends on the
 * template version as well as on the row it sits in. Both alterations the acceptance criterion names get
 * two assertions each, and the SECOND of the two is the one that matters: the fingerprint pre-check in
 * `open` refuses a mismatched binding before any decryption happens, so a test that stopped there would
 * prove nothing about the GCM tag. Forging the fingerprint to match makes AES-GCM itself the thing that
 * refuses, and the error is then an authentication failure rather than a bookkeeping one.
 *
 * Every case carries its own control — the same payload opened under the correct binding — because a
 * fixture that could not be opened at all would satisfy every `toThrow` here.
 */

const kek = generateKek('v1')

const ROW: RecordBinding = {
  table: 'clinical.intake_submission',
  recordId: '11111111-1111-1111-1111-111111111111',
  customerId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
}
const V3: RecordBinding = { ...ROW, context: 'template_version=3' }
const V4: RecordBinding = { ...ROW, context: 'template_version=4' }
const MOVED: RecordBinding = { ...V3, recordId: '33333333-3333-3333-3333-333333333333' }

/** Obviously-fake synthetic answers. No real person's health facts exist in this repository. */
const PLAINTEXT = JSON.stringify({
  recent_surgery: true,
  medication: 'SYNTHETIC-FIXTURE-NOT-REAL-ADVICE',
  notes: 'lower back, synthetic fixture row',
})

describe('the template version in the AAD', () => {
  it('control: a payload sealed with a context opens under exactly that context', () => {
    expect(open(kek, V3, seal(kek, V3, PLAINTEXT))).toBe(PLAINTEXT)
  })

  it('a payload with a context and one without are not interchangeable, in both directions', () => {
    // Absent is not the empty string and not any context. This is what stops a treatment note's
    // three-term payload being readable as an intake submission's four-term one, and it is also why
    // adding the field changed nothing about the staff records sealed under ADR 0025.
    const withContext = seal(kek, V3, PLAINTEXT)
    const without = seal(kek, ROW, PLAINTEXT)
    expect(() => open(kek, ROW, withContext)).toThrow(/binding does not match/)
    expect(() => open(kek, V3, without)).toThrow(/binding does not match/)
  })

  it('an altered template version is refused by the binding check', () => {
    const sealed = seal(kek, V3, PLAINTEXT)
    expect(() => open(kek, V4, sealed)).toThrow(/binding does not match/)
    expect(open(kek, V3, sealed)).toBe(PLAINTEXT)
  })

  it('an altered template version fails AUTHENTICATION with the fingerprint forged to match', () => {
    const sealed = seal(kek, V3, PLAINTEXT)
    // The attacker holds UPDATE, so they rewrite `template_version`, `aad_context` and
    // `aad_fingerprint` together, which defeats every stored consistency check. The GCM tag is what is
    // left, because the AAD participates in the tag itself.
    expect(() => open(kek, V4, { ...sealed, aadFingerprint: fingerprint(V4) })).toThrow(
      /failed authentication/,
    )
    expect(open(kek, V3, sealed)).toBe(PLAINTEXT)
  })

  it('an altered ROW ID is refused by the binding check', () => {
    const sealed = seal(kek, V3, PLAINTEXT)
    expect(() => open(kek, MOVED, sealed)).toThrow(/binding does not match/)
    expect(open(kek, V3, sealed)).toBe(PLAINTEXT)
  })

  it('an altered ROW ID fails AUTHENTICATION with the fingerprint forged to match', () => {
    const sealed = seal(kek, V3, PLAINTEXT)
    expect(() => open(kek, MOVED, { ...sealed, aadFingerprint: fingerprint(MOVED) })).toThrow(
      /failed authentication/,
    )
    expect(open(kek, V3, sealed)).toBe(PLAINTEXT)
  })

  it('the fingerprint discriminates on the context, which is what the pre-check is for', () => {
    expect(fingerprint(V3)).not.toBe(fingerprint(V4))
    expect(fingerprint(V3)).not.toBe(fingerprint(ROW))
  })

  it('a rotation re-wraps a four-term payload, and cannot with the term left out', () => {
    // The key store reads `aad_context` off the row for exactly this reason. A re-wrap that
    // reconstructed a three-term binding would fail to unwrap the data key, and it would arrive as
    // ClinicalDekUnwrapFailed on a row nothing is wrong with, half way through a rotation at 03:00.
    const v1 = generateKek('v1')
    const v2 = generateKek('v2')
    const sealed = seal(v1, V3, PLAINTEXT)
    expect(open(v2, V3, rewrap(v1, v2, V3, sealed))).toBe(PLAINTEXT)
    expect(() => rewrap(v1, v2, ROW, sealed)).toThrow(/unwrap/)
  })

  it('refuses a context containing the AAD separator', () => {
    expect(() => seal(kek, { ...ROW, context: 'a|b' }, PLAINTEXT)).toThrow(/AAD separator/)
  })
})

/**
 * The transform is a real one.
 *
 * A round trip through `seal` and `open` in one process with one key passes for a cipher that returns its
 * input, so it proves nothing on its own. These assert what an attacker holding the ROW sees: no run of
 * the plaintext anywhere in the stored bytes, a length that accounts for the GCM tag, and — the control
 * on the search itself — the same search finding every run in the plaintext.
 */
describe('what the stored bytes actually contain', () => {
  const RUN = 6

  /** Every `RUN`-character window of the plaintext, so a partially-encrypting cipher is caught too. */
  const windows = (text: string): readonly string[] =>
    Array.from({ length: Math.max(0, text.length - RUN) }, (_, index) =>
      text.slice(index, index + RUN),
    )

  it('holds no run of the plaintext in the ciphertext, the nonce or the wrapped key', () => {
    const sealed = seal(kek, V3, PLAINTEXT)
    const stored = Buffer.concat([sealed.ciphertext, sealed.nonce, sealed.wrappedDataKey]).toString(
      'latin1',
    )
    const leaked = windows(PLAINTEXT).filter((run) => stored.includes(run))
    expect(leaked, `stored bytes contain plaintext runs: ${leaked.join(', ')}`).toEqual([])
  })

  it('control: the same search DOES find every run in the plaintext itself', () => {
    // Without this, the assertion above is satisfied by a search that can never match — which is how a
    // leak sweep comes to report a clean result about a scan that examined nothing (ADR 0003).
    const runs = windows(PLAINTEXT)
    expect(runs.length).toBeGreaterThan(20)
    expect(runs.filter((run) => PLAINTEXT.includes(run))).toHaveLength(runs.length)
  })

  it('the ciphertext is the plaintext length plus a 16-byte tag, and is not the plaintext', () => {
    const sealed = seal(kek, V3, PLAINTEXT)
    const bytes = Buffer.byteLength(PLAINTEXT, 'utf8')
    expect(sealed.ciphertext.length).toBe(bytes + 16)
    expect(sealed.ciphertext.subarray(0, bytes).toString('utf8')).not.toBe(PLAINTEXT)
  })
})

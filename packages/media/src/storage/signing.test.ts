import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  createDocumentUrlSigner,
  DOCUMENT_SIGNATURE_PARAMS,
  DOCUMENT_SIGNING_FIELD_SEPARATOR,
  type DocumentSignatureSubject,
  type DocumentSigningKeyRing,
  documentSigningPayload,
  mintDocumentNonce,
} from './signing.ts'

/**
 * The private-document signature (W-SYS-14).
 *
 * Every case here pairs its claim with a control that must fail, because the whole of this module is a
 * refusal and a refusal is the easiest thing in a codebase to assert vacuously: a `verify` that returned
 * `refused` for everything would satisfy each negative case on its own.
 *
 * The keys are literals in this file and that is safe for two independent reasons, both of which
 * `scripts/check-secrets.mjs` is entitled to ask about. They are not credentials — no deployment holds
 * them, and nothing can be opened with them — and they carry the placeholder vocabulary that gate's rule
 * looks for, so they are exempt by shape as well as by fact. It is the same position
 * `apps/web/src/session.ts` takes for `UNKNOWN_HANDLE_HASH`.
 */
const CURRENT = 'fixture-unused-never-a-real-document-signing-key-current'
const RETIRED = 'fixture-unused-never-a-real-document-signing-key-retired'

const RING: DocumentSigningKeyRing = {
  current: { version: 'v2', secret: CURRENT },
  retired: { version: 'v1', secret: RETIRED },
}

const DOCUMENT = '0191f2c4-6b3a-7c1d-9e04-5a7b8c9d0e1f'
const OTHER_DOCUMENT = '0191f2c4-6b3a-7c1d-9e04-aaaaaaaaaaaa'
const NOW = 1_800_000_000
const SOON = NOW + 900

const signer = () => createDocumentUrlSigner(RING)

const signed = (overrides: Partial<Omit<DocumentSignatureSubject, 'keyVersion'>> = {}) =>
  signer().sign({
    documentId: DOCUMENT,
    documentClass: 'tax_invoice',
    expiresAtEpochSeconds: SOON,
    nonce: 'nonce-aaaaaaaaaaaaaa',
    ...overrides,
  })

const params = (query: string): URLSearchParams => new URLSearchParams(query)

describe('the canonical signing payload', () => {
  it('names the scheme first and joins every field with the unit separator', () => {
    const payload = documentSigningPayload({
      documentId: DOCUMENT,
      documentClass: 'payslip',
      expiresAtEpochSeconds: SOON,
      nonce: 'n1234567890abcdef',
      keyVersion: 'v2',
    })
    const fields = payload.split(DOCUMENT_SIGNING_FIELD_SEPARATOR)
    expect(fields[0]).toBe('berelax-private-document-v1')
    expect(fields).toEqual([
      'berelax-private-document-v1',
      DOCUMENT,
      'payslip',
      String(SOON),
      'n1234567890abcdef',
      'v2',
    ])
  })

  it('refuses a field carrying the separator, and an expiry that is not a whole positive second', () => {
    // The control for the injectivity property below: the separator being unusable INSIDE a field is what
    // makes the join one-to-one, and a caller that could smuggle one in would make `{a, bc}` and `{ab, c}`
    // the same payload.
    expect(() =>
      documentSigningPayload({
        documentId: DOCUMENT,
        documentClass: `tax${DOCUMENT_SIGNING_FIELD_SEPARATOR}invoice`,
        expiresAtEpochSeconds: SOON,
        nonce: 'n1234567890abcdef',
        keyVersion: 'v2',
      }),
    ).toThrow(/\[document-signing-field-unusable\]/)
    for (const expiry of [0, -1, 1.5, Number.NaN]) {
      expect(
        () =>
          documentSigningPayload({
            documentId: DOCUMENT,
            documentClass: 'payslip',
            expiresAtEpochSeconds: expiry,
            nonce: 'n1234567890abcdef',
            keyVersion: 'v2',
          }),
        String(expiry),
      ).toThrow(/\[document-signing-field-unusable\]/)
    }
    expect(() =>
      documentSigningPayload({
        documentId: DOCUMENT,
        documentClass: 'payslip',
        expiresAtEpochSeconds: SOON,
        nonce: 'n1234567890abcdef',
        keyVersion: 'v2',
      }),
    ).not.toThrow()
  })

  /**
   * The payload is INJECTIVE: two different field sets never join to one string.
   *
   * This is the property the separator choice exists for, and it is the one a `:` or a `|` would break. The
   * generator therefore draws fields that CAN collide — short strings over an alphabet containing the
   * characters a naive delimiter would be confused by — and the case counts how many generated pairs were
   * actually distinct, because a generator that mostly produced equal pairs would prove nothing (brief rule
   * 22). The floor is MEASURED, not chosen: 60 runs of 200 cases put the minimum distinct count at 198, so
   * 150 sits well under the observed minimum rather than just under it — a floor set at 197 would be its
   * own flake.
   */
  it('maps distinct field sets to distinct payloads, over fields a naive delimiter would confuse', () => {
    const risky = fc.stringMatching(/^[a-b:|.]{0,4}$/)
    let distinctPairs = 0
    fc.assert(
      fc.property(
        fc.tuple(risky, risky, risky),
        fc.tuple(risky, risky, risky),
        ([idA, classA, nonceA], [idB, classB, nonceB]) => {
          const build = (id: string, cls: string, nonce: string): string | null => {
            try {
              return documentSigningPayload({
                // A non-empty prefix, because the builder refuses an empty field and the property is about
                // the JOIN rather than about the emptiness check the case above covers.
                documentId: `d${id}`,
                documentClass: `c${cls}`,
                expiresAtEpochSeconds: SOON,
                nonce: `n${nonce}`,
                keyVersion: 'v2',
              })
            } catch {
              return null
            }
          }
          const left = build(idA, classA, nonceA)
          const right = build(idB, classB, nonceB)
          if (left === null || right === null) return true
          const same = idA === idB && classA === classB && nonceA === nonceB
          if (!same) distinctPairs += 1
          return same ? left === right : left !== right
        },
      ),
      { numRuns: 200 },
    )
    expect(
      distinctPairs,
      'the generator produced almost no DISTINCT pairs, so this property was asserted about equal inputs ' +
        'and would hold for a delimiter that collides. Widen the alphabet rather than lowering this floor.',
    ).toBeGreaterThan(150)
  })
})

describe('signing a document URL', () => {
  it('produces a query carrying the class, expiry, nonce, key version and signature', () => {
    const result = signed()
    const q = params(result.query)
    expect(q.get(DOCUMENT_SIGNATURE_PARAMS.documentClass)).toBe('tax_invoice')
    expect(q.get(DOCUMENT_SIGNATURE_PARAMS.expires)).toBe(String(SOON))
    expect(q.get(DOCUMENT_SIGNATURE_PARAMS.nonce)).toBe('nonce-aaaaaaaaaaaaaa')
    // Signed under the CURRENT key, never the retired one. The retired slot is verification-only, which is
    // what makes a rotation a one-way door rather than a state where two keys are both current.
    expect(q.get(DOCUMENT_SIGNATURE_PARAMS.keyVersion)).toBe('v2')
    expect(q.get(DOCUMENT_SIGNATURE_PARAMS.signature)).toMatch(/^[0-9a-f]{64}$/)
    expect(result.keyVersion).toBe('v2')
    expect(signer().keyVersion).toBe('v2')
  })

  it('never puts the storage key or any bucket path in the query', () => {
    // The reason `sign` takes a document id rather than a key: `scripts/check-media.mjs` refuses a private
    // origin in source precisely so no path into that bucket travels, and a signed key would put one in a
    // link instead.
    const result = signed()
    expect(result.query).not.toContain('/')
    expect(result.query).not.toContain('originals')
  })

  it('refuses a key ring whose keys are unusable, and accepts the one this file uses', () => {
    expect(() =>
      createDocumentUrlSigner({ current: { version: 'v1', secret: 'too-short' } }),
    ).toThrow(/\[document-signing-key-too-short\]/)
    expect(() => createDocumentUrlSigner({ current: { version: 'V 1', secret: CURRENT } })).toThrow(
      /\[document-signing-key-version-unusable\]/,
    )
    expect(() =>
      createDocumentUrlSigner({
        current: { version: 'v1', secret: CURRENT },
        retired: { version: 'v1', secret: RETIRED },
      }),
    ).toThrow(/\[document-signing-key-versions-collide\]/)
    expect(() => createDocumentUrlSigner(RING)).not.toThrow()
  })

  it('mints a nonce that is long, url-safe and not the same twice', () => {
    const drawn = new Set(Array.from({ length: 200 }, () => mintDocumentNonce()))
    expect(drawn.size).toBe(200)
    for (const nonce of drawn) expect(nonce).toMatch(/^[A-Za-z0-9_-]{20,30}$/)
  })
})

describe('verifying a document signature', () => {
  it('accepts its own signature for its own document', () => {
    const result = signer().verify(params(signed().query), { documentId: DOCUMENT }, NOW)
    expect(result.kind).toBe('valid')
    if (result.kind !== 'valid') return
    expect(result.documentClass).toBe('tax_invoice')
    expect(result.nonce).toBe('nonce-aaaaaaaaaaaaaa')
    expect(result.keyVersion).toBe('v2')
  })

  it('names an ABSENT signature differently from a malformed one', () => {
    // The pair the acceptance line is about, one level below the route. An empty query is the ordinary case
    // — a pasted URL, a bookmark, a crawler — and reporting it as malformed would file every one of those
    // under "somebody is constructing signatures".
    expect(signer().verify(params(''), { documentId: DOCUMENT }, NOW)).toEqual({
      kind: 'refused',
      reason: 'signature_absent',
    })
    const partial = params(signed().query)
    partial.delete(DOCUMENT_SIGNATURE_PARAMS.nonce)
    expect(signer().verify(partial, { documentId: DOCUMENT }, NOW)).toEqual({
      kind: 'refused',
      reason: 'signature_malformed',
    })
  })

  it('refuses an EXPIRED signature with a distinct reason from an absent one, and only after the MAC', () => {
    const stale = signed({ expiresAtEpochSeconds: NOW - 1 })
    expect(signer().verify(params(stale.query), { documentId: DOCUMENT }, NOW)).toEqual({
      kind: 'refused',
      reason: 'signature_expired',
    })

    /*
      The ORDER, asserted rather than assumed, and this is the case that would catch it being swapped.

      A forged signature with an expiry in the past must report `signature_invalid` and not
      `signature_expired`: if expiry were judged first, an attacker who guessed a signature and back-dated
      `exp` would be filed as somebody holding a stale link, and the log would stop distinguishing "somebody
      kept an old email" from "somebody is guessing" — which is exactly the pair the acceptance line asks to
      be kept apart.
    */
    const forgedAndStale = params(stale.query)
    forgedAndStale.set(DOCUMENT_SIGNATURE_PARAMS.signature, 'a'.repeat(64))
    expect(signer().verify(forgedAndStale, { documentId: DOCUMENT }, NOW)).toEqual({
      kind: 'refused',
      reason: 'signature_invalid',
    })

    // And the boundary: a signature expiring exactly now is dead, because `<=`. A link that is valid at its
    // own expiry instant is a link whose TTL is one second longer than it says.
    const atTheInstant = signed({ expiresAtEpochSeconds: NOW })
    expect(signer().verify(params(atTheInstant.query), { documentId: DOCUMENT }, NOW)).toEqual({
      kind: 'refused',
      reason: 'signature_expired',
    })
    expect(
      signer().verify(
        params(signed({ expiresAtEpochSeconds: NOW + 1 }).query),
        {
          documentId: DOCUMENT,
        },
        NOW,
      ).kind,
    ).toBe('valid')
  })

  it('refuses a signature for document A against document B — the swapped path', () => {
    // THE case the acceptance line names, and the reason the document id is only in the PATH: nothing else
    // in the query identifies the document, so a swap can only be caught by the MAC. A scheme that also
    // carried the id as a parameter would refuse this by comparing strings, and would therefore pass even
    // if the signature covered nothing but the expiry and the nonce.
    const link = signed()
    expect(signer().verify(params(link.query), { documentId: OTHER_DOCUMENT }, NOW)).toEqual({
      kind: 'refused',
      reason: 'signature_invalid',
    })
    // The control: the same bytes, against the document they were minted for.
    expect(signer().verify(params(link.query), { documentId: DOCUMENT }, NOW).kind).toBe('valid')
  })

  it('refuses a signature whose CLASS was edited, so a reclassified document cannot be reopened', () => {
    const link = params(signed().query)
    link.set(DOCUMENT_SIGNATURE_PARAMS.documentClass, 'payslip')
    expect(signer().verify(link, { documentId: DOCUMENT }, NOW)).toEqual({
      kind: 'refused',
      reason: 'signature_invalid',
    })
  })

  it('accepts a link signed under the RETIRED key, and names an unknown key as such', () => {
    // The rotation, from both sides. A link minted before the rotation still opens…
    const old = createDocumentUrlSigner({ current: { version: 'v1', secret: RETIRED } }).sign({
      documentId: DOCUMENT,
      documentClass: 'tax_invoice',
      expiresAtEpochSeconds: SOON,
      nonce: 'nonce-bbbbbbbbbbbbbb',
    })
    expect(signer().verify(params(old.query), { documentId: DOCUMENT }, NOW).kind).toBe('valid')

    // …and a ring that has dropped the retired slot reports it as OURS-but-dead rather than as a forgery,
    // which is the distinction the version label exists for and the one the runbook's "invalidate every
    // outstanding link NOW" step depends on.
    const rotatedHard = createDocumentUrlSigner({ current: { version: 'v2', secret: CURRENT } })
    expect(rotatedHard.verify(params(old.query), { documentId: DOCUMENT }, NOW)).toEqual({
      kind: 'refused',
      reason: 'signature_unknown_key',
    })
  })

  it('refuses a signature made under the retired key but LABELLED as the current one', () => {
    // A relabel is not a rotation. Without this the label would be a hint rather than part of the signed
    // payload, and an attacker who knew any retired key could present its output as current.
    const old = createDocumentUrlSigner({ current: { version: 'v1', secret: RETIRED } }).sign({
      documentId: DOCUMENT,
      documentClass: 'tax_invoice',
      expiresAtEpochSeconds: SOON,
      nonce: 'nonce-cccccccccccccc',
    })
    const relabelled = params(old.query)
    relabelled.set(DOCUMENT_SIGNATURE_PARAMS.keyVersion, 'v2')
    expect(signer().verify(relabelled, { documentId: DOCUMENT }, NOW)).toEqual({
      kind: 'refused',
      reason: 'signature_invalid',
    })
  })

  it('refuses every malformed shape without reaching the MAC, including a wrong-length signature', () => {
    const shapes: readonly (readonly [string, string])[] = [
      [DOCUMENT_SIGNATURE_PARAMS.signature, 'a'.repeat(63)],
      [DOCUMENT_SIGNATURE_PARAMS.signature, `A${'a'.repeat(63)}`],
      [DOCUMENT_SIGNATURE_PARAMS.expires, '-1'],
      [DOCUMENT_SIGNATURE_PARAMS.expires, '1e9'],
      [DOCUMENT_SIGNATURE_PARAMS.expires, ' 1800000900'],
      [DOCUMENT_SIGNATURE_PARAMS.nonce, 'short'],
      [DOCUMENT_SIGNATURE_PARAMS.nonce, `${'n'.repeat(16)}!`],
      [DOCUMENT_SIGNATURE_PARAMS.keyVersion, 'V2'],
      [DOCUMENT_SIGNATURE_PARAMS.documentClass, ''],
    ]
    for (const [key, value] of shapes) {
      const broken = params(signed().query)
      broken.set(key, value)
      expect(
        signer().verify(broken, { documentId: DOCUMENT }, NOW),
        `${key}=${JSON.stringify(value)}`,
      ).toEqual({ kind: 'refused', reason: 'signature_malformed' })
    }
    // The control. Without it a `verify` that answered `signature_malformed` unconditionally would pass
    // every case above.
    expect(signer().verify(params(signed().query), { documentId: DOCUMENT }, NOW).kind).toBe(
      'valid',
    )
  })

  /**
   * Changing ANY signed field refuses, over generated values.
   *
   * The counted quantity is how many generated cases actually CHANGED something: a mutation that happened
   * to draw the original value would make the property assert that an unmodified link verifies, which is
   * the opposite claim. Measured: 60 runs of 300 cases never drew the original value, so the minimum is 300
   * and the floor of 250 is a guard against the generator being narrowed later rather than against today's
   * distribution. 30_000 ms because 300 cases each compute two HMACs and vitest's inherited timeout is
   * 5_000 — brief rule 21, and the reason four files have failed on it under coverage.
   */
  it('refuses any edit to a signed field, and accepts the untouched link', () => {
    let mutated = 0
    fc.assert(
      fc.property(
        fc.constantFrom(
          DOCUMENT_SIGNATURE_PARAMS.documentClass,
          DOCUMENT_SIGNATURE_PARAMS.expires,
          DOCUMENT_SIGNATURE_PARAMS.nonce,
        ),
        fc.oneof(
          fc.constantFrom('payslip', 'clinical_extract', 'tax_credit_note'),
          fc.integer({ min: NOW + 1, max: NOW + 100_000 }).map(String),
          fc.stringMatching(/^[A-Za-z0-9_-]{16,24}$/),
        ),
        (key, value) => {
          const original = signed()
          const edited = params(original.query)
          if (edited.get(key) === value) return true
          mutated += 1
          edited.set(key, value)
          const outcome = signer().verify(edited, { documentId: DOCUMENT }, NOW)
          // Either the edit is refused by shape (a class where an expiry belongs) or by the MAC. What must
          // never happen is `valid`.
          return outcome.kind === 'refused'
        },
      ),
      { numRuns: 300 },
    )
    expect(
      mutated,
      'almost no generated case actually changed a field, so this property was asserted about untouched ' +
        'links and would hold for a verifier that accepts everything',
    ).toBeGreaterThan(250)
    expect(signer().verify(params(signed().query), { documentId: DOCUMENT }, NOW).kind).toBe(
      'valid',
    )
  }, 30_000)
})

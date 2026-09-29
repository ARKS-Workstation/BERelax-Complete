/**
 * The signed URL for a private document: minted here, verified here, and never by the provider (W-SYS-14).
 *
 * ## What "verifiable without the provider" means and why it is the requirement
 *
 * DigitalOcean Spaces signs a URL the way S3 does, and that signature can only be checked by the service
 * that holds the bucket credential. Two consequences follow, and both are disqualifying for this build.
 * A refusal would arrive as a 403 from a third-party origin with an XML body, so "this link expired" and
 * "somebody is guessing" would be the same fact — the distinction the acceptance line is about. And there
 * is no real adapter at all (W-SYS-05's `[no-real-media-storage-adapter]`), so a scheme that needed one
 * could not be tested; ADR 0005 and ADR 0022 forbid reaching a real provider outside production anyway.
 *
 * So this signs a **detached** signature: an HMAC over a canonical description of the document, carried in
 * the query string, verified in this process against a key ring it holds. The bytes still come out of
 * whichever adapter is configured, and the adapter does not decide who gets them.
 *
 * ## Why an HMAC and not a stored grant, when M-VAT-11 chose a stored grant
 *
 * M-VAT-11 built a stored grant for `obligation_evidence` and its header argues the case: no fourth
 * signing secret, revocable by DELETE, and it records who asked. Every one of those arguments is correct,
 * and this unit takes the other side for a different problem. ADR 0051 is the full argument; the short
 * form is that a stored grant needs a row per link, which means a WRITE on the path that mints one — so
 * the screen that offers six downloads writes six rows, and a link nobody follows is a row nobody
 * collects. A signature is minted by a pure function, costs nothing to offer, and — the part that decided
 * it — the single-use documents are single-use in the DATABASE either way, because a check-then-insert in
 * TypeScript is two statements and two concurrent fetches pass both. Given that the replay defence has to
 * be a row regardless, the stored grant was buying revocability for a fifteen-minute link.
 *
 * ## The key ring, and why the version label is in the signature
 *
 * `DOCUMENT_URL_SIGNING_SECRET` with a version label, and a retired slot read on verification only — the
 * arrangement `SUPPRESSION_PEPPER` already uses. The version is IN the signed payload and in the URL, and
 * that is not bookkeeping: without it, a link signed under a key this deployment has rotated away from is
 * a bad MAC, which is indistinguishable from a forgery. With it, the refusal is `signature_unknown_key` —
 * "signed by us, under a key we no longer hold" — which is a different line in a log and a different
 * answer at 02:00.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { AppError } from '@berelax/shared'

/** The scheme's own name, FIRST in the payload so a future scheme can never collide with this one. */
export const DOCUMENT_SIGNING_SCHEME = 'berelax-private-document-v1'

/**
 * The delimiter between signed fields: UNIT SEPARATOR.
 *
 * `:` and `|` are the obvious choices and both are wrong. Every field here is caller-supplied text — a
 * uuid, a class name, a version label — and a delimiter that can appear inside a field makes the mapping
 * from fields to payload non-injective: `{a, bc}` and `{ab, c}` join to the same string under `|`, so a
 * signature over one verifies against the other. U+001F cannot appear in a URL query value without being
 * percent-encoded, and {@link documentSigningPayload} refuses it inside a field anyway, so the mapping is
 * injective by construction rather than by luck.
 */
export const DOCUMENT_SIGNING_FIELD_SEPARATOR = '\u001f'

/** The query parameters a signed document URL carries. Short names: they go in a link somebody pastes. */
export const DOCUMENT_SIGNATURE_PARAMS = {
  expires: 'exp',
  nonce: 'n',
  keyVersion: 'kid',
  documentClass: 'cls',
  signature: 'sig',
} as const

/**
 * What a signature is computed over.
 *
 * `documentClass` is signed as well as the id, and the reason is a real failure rather than belt and
 * braces: a document re-registered under a more permissive class would otherwise be openable with the
 * signature minted while it was restricted. Migration 0101 refuses that re-registration too — the register
 * is append-only — so this is the second of two layers, which is the arrangement this build uses wherever
 * one layer holds under a restore and the other gives a person a sentence.
 */
export interface DocumentSignatureSubject {
  readonly documentId: string
  readonly documentClass: string
  /** Seconds since the epoch, as a whole positive integer: the finest granularity a URL needs. */
  readonly expiresAtEpochSeconds: number
  readonly nonce: string
  readonly keyVersion: string
}

/**
 * The canonical string, from the FIELDS rather than from a rendered URL.
 *
 * A signature over a URL is a signature over whatever a proxy, a redirect or a client library did to the
 * query string — parameter order, percent-encoding, an appended tracking parameter — so the same link
 * verifies on one hop and fails on the next. Every field is in it, and each one stops something:
 *
 *   - `documentId` — without it the signature is a bearer token for every document in the business;
 *   - `expiresAtEpochSeconds` — without it in the SIGNED payload, the expiry is a parameter an attacker
 *     edits;
 *   - `nonce` — what a single-use fetch burns; two links to one document differ in nothing else, so
 *     without it the second link IS the first and burning either kills both;
 *   - `keyVersion` — so a link signed under a retired key is not read as a forgery;
 *   - `documentClass` — see {@link DocumentSignatureSubject}.
 */
export function documentSigningPayload(subject: DocumentSignatureSubject): string {
  if (!Number.isInteger(subject.expiresAtEpochSeconds) || subject.expiresAtEpochSeconds <= 0) {
    throw new AppError(
      'validation',
      `[document-signing-field-unusable] an expiry of ${subject.expiresAtEpochSeconds} is not a whole ` +
        'positive number of seconds since the epoch, so it would render differently on the two sides of ' +
        'the signature',
      { details: { expiresAtEpochSeconds: subject.expiresAtEpochSeconds } },
    )
  }
  const fields = [
    DOCUMENT_SIGNING_SCHEME,
    subject.documentId,
    subject.documentClass,
    String(subject.expiresAtEpochSeconds),
    subject.nonce,
    subject.keyVersion,
  ]
  for (const [index, field] of fields.entries()) {
    if (field.length === 0 || field.includes(DOCUMENT_SIGNING_FIELD_SEPARATOR)) {
      throw new AppError(
        'validation',
        `[document-signing-field-unusable] signed field ${index} is empty or contains the unit ` +
          'separator, so two different field sets could produce one payload and a signature over one ' +
          'would verify against the other',
        { details: { index, length: field.length } },
      )
    }
  }
  return fields.join(DOCUMENT_SIGNING_FIELD_SEPARATOR)
}

/**
 * One key and the label it is known by.
 *
 * The label goes in the URL, so it is a public identifier and must name nothing about the key. `v1`, `v2`.
 */
export interface DocumentSigningKey {
  readonly version: string
  /** The HMAC key. Never logged, never in an error, never returned by anything here. */
  readonly secret: string
}

export interface DocumentSigningKeyRing {
  readonly current: DocumentSigningKey
  /**
   * The outgoing key, consulted on VERIFICATION only.
   *
   * Never used to sign, which is what makes a rotation a one-way door rather than a state where two keys
   * are both current. Its presence is what makes the rotation seamless for the links already in flight:
   * without it, rotating kills every link minted in the previous fifteen minutes, and the reader sees a
   * document that will not open with no way to tell that from a refusal.
   */
  readonly retired?: DocumentSigningKey | undefined
}

/** Why a signature was refused. Each is a different fact to whoever reads the log. */
export const DOCUMENT_SIGNATURE_REFUSALS = [
  'signature_absent',
  'signature_malformed',
  'signature_unknown_key',
  'signature_invalid',
  'signature_expired',
] as const
export type DocumentSignatureRefusal = (typeof DOCUMENT_SIGNATURE_REFUSALS)[number]

export interface SignedDocumentQuery {
  /** The query string, without a leading `?`, in the order this module writes it. */
  readonly query: string
  readonly expiresAtEpochSeconds: number
  readonly nonce: string
  readonly keyVersion: string
}

/**
 * The bytes of the MAC, hex.
 *
 * sha256 truncated to nothing: the whole digest. A truncated MAC saves 32 characters in a URL nobody
 * types and costs the only property the scheme has.
 */
function mac(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex')
}

/**
 * A nonce: 16 bytes of `randomBytes` in base64url.
 *
 * 128 bits, so two links to one document never collide and a single-use burn can never be another link's.
 * base64url rather than hex because it goes in a URL, and rather than base64 because `+` and `/` would
 * have to be escaped by every caller that builds one.
 */
export function mintDocumentNonce(): string {
  return randomBytes(16).toString('base64url')
}

/**
 * The signer. Constructed from a key ring rather than from the environment.
 *
 * Injected because `@berelax/media` must not read configuration — the derivative job, the route and the
 * tests each wire their own — and because a signer built from `process.env` could not be handed a key ring
 * with a retired slot in a test, which is the half of the rotation nobody would then have exercised.
 */
export interface DocumentUrlSigner {
  /** The version the current key is known by, so a caller can report which key it signed under. */
  readonly keyVersion: string
  sign(subject: Omit<DocumentSignatureSubject, 'keyVersion'>): SignedDocumentQuery
  verify(
    params: URLSearchParams,
    expected: { readonly documentId: string },
    nowEpochSeconds: number,
  ):
    | VerifiedDocumentSignature
    | { readonly kind: 'refused'; readonly reason: DocumentSignatureRefusal }
}

export interface VerifiedDocumentSignature {
  readonly kind: 'valid'
  readonly documentId: string
  readonly documentClass: string
  readonly nonce: string
  readonly keyVersion: string
  readonly expiresAtEpochSeconds: number
}

const NONCE_SHAPE = /^[A-Za-z0-9_-]{16,64}$/
const KEY_VERSION_SHAPE = /^[a-z0-9][a-z0-9._-]{0,31}$/

export function createDocumentUrlSigner(ring: DocumentSigningKeyRing): DocumentUrlSigner {
  for (const key of [ring.current, ring.retired]) {
    if (key === undefined) continue
    if (!KEY_VERSION_SHAPE.test(key.version)) {
      throw new AppError(
        'validation',
        `[document-signing-key-version-unusable] '${key.version}' is not a usable key version. It goes ` +
          'in a URL and is compared byte for byte, so it is lower-case alphanumerics with dots, dashes ' +
          'and underscores and nothing else.',
        { details: { version: key.version } },
      )
    }
    // 32 characters, not 32 bytes of entropy — this cannot measure entropy and must not pretend to. It
    // refuses the two values that actually arrive: an empty variable, and a placeholder somebody typed.
    if (key.secret.length < 32) {
      throw new AppError(
        'validation',
        '[document-signing-key-too-short] a document signing key must be at least 32 characters. A ' +
          'short one is an unset environment variable or a placeholder, and either would make every ' +
          'signature forgeable by anybody who guessed it.',
        { details: { version: key.version, length: key.secret.length } },
      )
    }
  }
  if (ring.retired !== undefined && ring.retired.version === ring.current.version) {
    throw new AppError(
      'validation',
      `[document-signing-key-versions-collide] the current and retired keys are both labelled ` +
        `'${ring.current.version}', so verification cannot tell which one a link was signed under and ` +
        'the rotation this slot exists for would silently accept the wrong key',
      { details: { version: ring.current.version } },
    )
  }

  const byVersion = new Map<string, string>([[ring.current.version, ring.current.secret]])
  if (ring.retired !== undefined) byVersion.set(ring.retired.version, ring.retired.secret)

  return {
    keyVersion: ring.current.version,

    sign(subject) {
      const full: DocumentSignatureSubject = { ...subject, keyVersion: ring.current.version }
      const signature = mac(ring.current.secret, documentSigningPayload(full))
      const params = new URLSearchParams()
      params.set(DOCUMENT_SIGNATURE_PARAMS.documentClass, full.documentClass)
      params.set(DOCUMENT_SIGNATURE_PARAMS.expires, String(full.expiresAtEpochSeconds))
      params.set(DOCUMENT_SIGNATURE_PARAMS.nonce, full.nonce)
      params.set(DOCUMENT_SIGNATURE_PARAMS.keyVersion, full.keyVersion)
      params.set(DOCUMENT_SIGNATURE_PARAMS.signature, signature)
      return {
        query: params.toString(),
        expiresAtEpochSeconds: full.expiresAtEpochSeconds,
        nonce: full.nonce,
        keyVersion: full.keyVersion,
      }
    },

    verify(params, expected, nowEpochSeconds) {
      const signature = params.get(DOCUMENT_SIGNATURE_PARAMS.signature)
      const documentClass = params.get(DOCUMENT_SIGNATURE_PARAMS.documentClass)
      const expires = params.get(DOCUMENT_SIGNATURE_PARAMS.expires)
      const nonce = params.get(DOCUMENT_SIGNATURE_PARAMS.nonce)
      const keyVersion = params.get(DOCUMENT_SIGNATURE_PARAMS.keyVersion)

      // Absent is its own refusal and comes FIRST, before any shape check. "This request carried no
      // signature" is the ordinary case — a bare URL somebody pasted, a crawler, a bookmark — and reporting
      // it as malformed would file every one of those under "somebody is constructing signatures".
      if (
        signature === null &&
        documentClass === null &&
        expires === null &&
        nonce === null &&
        keyVersion === null
      ) {
        return { kind: 'refused', reason: 'signature_absent' }
      }
      if (
        signature === null ||
        documentClass === null ||
        expires === null ||
        nonce === null ||
        keyVersion === null
      ) {
        return { kind: 'refused', reason: 'signature_malformed' }
      }
      const expiresAtEpochSeconds = Number(expires)
      if (
        !/^\d{1,12}$/.test(expires) ||
        !Number.isInteger(expiresAtEpochSeconds) ||
        expiresAtEpochSeconds <= 0 ||
        !NONCE_SHAPE.test(nonce) ||
        !KEY_VERSION_SHAPE.test(keyVersion) ||
        !/^[0-9a-f]{64}$/.test(signature) ||
        documentClass.includes(DOCUMENT_SIGNING_FIELD_SEPARATOR) ||
        documentClass.length === 0
      ) {
        return { kind: 'refused', reason: 'signature_malformed' }
      }

      const secret = byVersion.get(keyVersion)
      if (secret === undefined) return { kind: 'refused', reason: 'signature_unknown_key' }

      const expectedMac = mac(
        secret,
        documentSigningPayload({
          documentId: expected.documentId,
          documentClass,
          expiresAtEpochSeconds,
          nonce,
          keyVersion,
        }),
      )
      /*
        `timingSafeEqual` on the raw bytes, and the length is already fixed by the hex shape check above —
        which is what makes this safe to call at all: it THROWS on a length mismatch, so a caller that
        reached it with an attacker-controlled length would turn a forged signature into a 500.
      */
      if (!timingSafeEqual(Buffer.from(expectedMac, 'hex'), Buffer.from(signature, 'hex'))) {
        /*
          One refusal for a tampered signature AND for a genuine signature pointed at another document, and
          that is deliberate rather than a missing distinction.

          The tempting version carries the document id it was signed for as its own parameter, so a valid
          MAC over the wrong document can be named. It is worse, and the reason is what such a scheme does
          to the TEST: if the signature covered only the expiry and the nonce — a signature over the wrong
          thing, which is the defect the acceptance line is about — then swapping the path would still be
          refused, by the parameter rather than by the MAC, and the case would report PASS about a broken
          scheme. Here the document id is only in the path, so the swap can only be caught by the MAC, and
          the case cannot pass unless the MAC really covers it.
        */
        return { kind: 'refused', reason: 'signature_invalid' }
      }

      /*
        Expiry AFTER the MAC, and the order is the whole of what makes the two refusals mean anything.

        MAC first: a signature that verifies and has expired is a STALE LINK — ours, issued, followed too
        late. Expiry first: an attacker who guesses a signature and sets `exp` to yesterday is reported as a
        stale link, so the log stops distinguishing "somebody kept an old email" from "somebody is
        guessing", which is exactly the pair the acceptance line asks to be kept apart.
      */
      if (expiresAtEpochSeconds <= nowEpochSeconds) {
        return { kind: 'refused', reason: 'signature_expired' }
      }

      return {
        kind: 'valid',
        documentId: expected.documentId,
        documentClass,
        nonce,
        keyVersion,
        expiresAtEpochSeconds,
      }
    },
  }
}

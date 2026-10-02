/**
 * Hashed match keys for a server-side conversion, and the committed vectors that prove the normalisation
 * (A-MEAS-03).
 *
 * ## Why normalisation is the whole of this module and hashing is one line
 *
 * Both platforms match a hashed contact detail against their own hash of the same detail, so the digests
 * agree only if the normalisation agrees. `050 342 9399`, `+971 50 342 9399` and `00971503429399` are one
 * number to the person who gave it and three strings to SHA-256 — and the failure is silent in the worst
 * possible way: the payload is accepted, the conversion is recorded as unmatched, and the campaign that
 * produced it looks like a campaign that produced nothing. Nothing errors and nothing is logged.
 *
 * So the acceptance line is a set of COMMITTED VECTORS rather than a property: the three spellings above
 * produce one identical lowercase-hex digest, and `'  Name@Example.COM '` produces the digest of
 * `'name@example.com'`. `identity.test.ts` asserts the equalities AND asserts the digests are not equal to
 * the digest of the raw input — because three functions that all return the empty string satisfy "they
 * agree" perfectly.
 *
 * ## The phone normaliser is `@berelax/core`'s and is not re-implemented here
 *
 * `normalisePhoneResult` already folds Arabic-Indic digits, non-breaking spaces, the `00` international
 * prefix and the trunk `0`, and it is the function the customer record is keyed on. A second normaliser
 * here would be a second answer to what one phone number is, drifting apart the first time either is
 * extended — and the two sides of that drift are "which customer is this" and "which conversion is this",
 * which is exactly the join a conversion API is for.
 *
 * What this module adds on top is the ONE transformation the platforms require and this build's identity
 * does not: the digits WITHOUT the `+`. E.164 with the plus is the stored form (ADR 0007's sibling
 * convention for time: the canonical form is stored and the presentation form is derived), and both
 * platforms document their phone normalisation as digits including the country code and no punctuation.
 * Stripping it here rather than in each adapter is what keeps the two adapters' digests equal.
 *
 * ## A number this build cannot normalise is NOT hashed
 *
 * `normalisePhoneResult` refuses a landline, a foreign number and a typo. None of those is hashed into a
 * payload: a digest of an unnormalised string is a match key that matches nothing, and it is
 * indistinguishable on the wire from one that should have matched. So the field is simply absent, which is
 * the one honest answer — and the refusal reason is returned so the consumer can count it rather than
 * discover it.
 *
 * ## Purity, and why this is not in `packages/core`
 *
 * `node:crypto` is not forbidden in `packages/core`, so this module could have lived there. It is here
 * because hashing a contact detail is only ever done for an outbound platform payload, and
 * `packages/core/src/analytics` is the estate `scripts/check-egress-guard.mjs` holds to "reaches no
 * network global and holds no catalogue name". Putting the match keys beside the adapters keeps the
 * guard's estate exactly the two modules it names.
 */
import { createHash } from 'node:crypto'
import { normalisePhoneResult, type PhoneRejection } from '@berelax/core'
import type { HashedUserData } from './port.ts'

/**
 * The one hash function. SHA-256, lowercase hex, UTF-8 input.
 *
 * Both platforms document exactly this and neither accepts anything else, so there is no algorithm
 * argument: a parameter would be a knob whose wrong setting produces a payload that is accepted and
 * matches nobody. `digest('hex')` is already lowercase in Node, and `.toLowerCase()` is written anyway
 * because the claim in the acceptance line is about the BYTES and a future `digest` that upper-cased them
 * would break every match with nothing failing here.
 */
export const sha256Lower = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex').toLowerCase()

/**
 * The normalised form of an email address, before hashing.
 *
 * Trim and lower-case, and nothing else. Specifically NOT the two transformations an implementation is
 * tempted into: no dot-stripping and no `+tag` removal in the local part. Those are one provider's
 * delivery rules, not a normalisation — `a.b@example.com` and `ab@example.com` are the same mailbox at one
 * provider and two different people at another, so applying them would merge two customers into one
 * conversion. Both platforms document trim-and-lowercase and nothing more.
 */
export const normaliseEmailForMatching = (raw: string): string => raw.trim().toLowerCase()

export const emailSha256 = (raw: string): string => sha256Lower(normaliseEmailForMatching(raw))

/**
 * The normalised form of a phone number, before hashing: E.164 digits with no `+`.
 *
 * Returns the rejection rather than throwing, because the first caller is a worker draining a queue and a
 * customer with a landline is ordinary rather than a bug.
 */
export type PhoneMatchKey =
  | { readonly ok: true; readonly digits: string }
  | { readonly ok: false; readonly reason: PhoneRejection }

export function phoneDigitsForMatching(raw: string): PhoneMatchKey {
  const normalised = normalisePhoneResult(raw)
  if (!normalised.ok) return { ok: false, reason: normalised.reason }
  // The `+` and nothing else. A `replace(/\D/g, '')` here would also silently accept an un-normalised
  // input, which is the branch above's job to refuse.
  return { ok: true, digits: normalised.e164.replace(/^\+/, '') }
}

export function phoneSha256(
  raw: string,
): { readonly sha256: string } | { readonly sha256: null; readonly reason: PhoneRejection } {
  const key = phoneDigitsForMatching(raw)
  return key.ok ? { sha256: sha256Lower(key.digits) } : { sha256: null, reason: key.reason }
}

/** Why a contact detail was not hashed into a payload. Counted by the consumer, never inferred. */
export const USER_DATA_OMISSIONS = ['absent', 'unnormalisable'] as const
export type UserDataOmission = (typeof USER_DATA_OMISSIONS)[number]

export interface HashedUserDataResult {
  readonly userData: HashedUserData
  /**
   * Why each field is missing. A key is present exactly for a field `userData` does not carry.
   *
   * `Partial` rather than a total record of `| undefined`, because `exactOptionalPropertyTypes` is on and
   * the two are different claims: a total record would require every caller to write `email: undefined`,
   * which is a value, where this says the key is simply not there. A consumer counting omissions reads
   * `Object.keys`, so a present-and-undefined key would be counted as an omission that did not happen.
   */
  readonly omitted: Readonly<Partial<Record<'phone' | 'email', UserDataOmission>>>
}

/**
 * Builds the hashed match keys for one conversion, and says what it could not hash.
 *
 * `exactOptionalPropertyTypes` is on, so an absent field is genuinely absent rather than present and
 * `undefined` — which matters on the wire: `{"ph": undefined}` serialises to `{}` but
 * `{"ph": null}` does not, and Meta treats a null match key as a key that matched nobody rather than as
 * no key at all.
 *
 * `fbp` and `fbc` pass through verbatim and unhashed. They are Meta's own cookie values: already opaque to
 * us, unmatchable if hashed, and the only thing that joins a server-side conversion to the click that
 * produced it. An empty or blank string is dropped rather than forwarded, because a present-but-empty
 * match key is the shape that makes a platform report a match attempt that could not have succeeded.
 */
export function hashedUserData(input: {
  readonly phone?: string | null
  readonly email?: string | null
  readonly fbp?: string | null
  readonly fbc?: string | null
}): HashedUserDataResult {
  const omitted: { phone?: UserDataOmission; email?: UserDataOmission } = {}
  const userData: {
    phoneSha256?: string
    emailSha256?: string
    fbp?: string
    fbc?: string
  } = {}

  const phone = input.phone ?? ''
  if (phone.trim().length === 0) {
    omitted.phone = 'absent'
  } else {
    const hashed = phoneSha256(phone)
    if (hashed.sha256 === null) omitted.phone = 'unnormalisable'
    else userData.phoneSha256 = hashed.sha256
  }

  const email = input.email ?? ''
  if (email.trim().length === 0) {
    omitted.email = 'absent'
  } else {
    const normalised = normaliseEmailForMatching(email)
    // One structural check and no pattern: an address with no `@` cannot be an address, and anything
    // stricter here would be a second, weaker statement of what a valid address is — the booking form's
    // validation is the one that decides whether a customer may be recorded.
    if (!normalised.includes('@')) omitted.email = 'unnormalisable'
    else userData.emailSha256 = sha256Lower(normalised)
  }

  const fbp = (input.fbp ?? '').trim()
  if (fbp.length > 0) userData.fbp = fbp
  const fbc = (input.fbc ?? '').trim()
  if (fbc.length > 0) userData.fbc = fbc

  return { userData, omitted }
}

/**
 * The committed hashing vectors, as DATA, so the test and this module cannot disagree about the claim.
 *
 * The acceptance line names these spellings. They are here rather than only in the test because the claim
 * is about this build's behaviour rather than about a test's expectations, and because
 * `packages/fixtures/src/analytics-dispatch.itest.ts` asserts the same equalities over the adapters' real
 * bodies — one statement of the vectors, read by both.
 *
 * No expected digest is written down. A committed digest would be a fourth statement that a changed
 * normalisation could be made to agree with by editing it; the claim is that the three AGREE and that none
 * of them is the digest of its own raw input, which no edit can satisfy vacuously.
 */
export const PHONE_HASHING_VECTORS = Object.freeze([
  '050 342 9399',
  '+971503429399',
  '00971503429399',
] as const)

export const EMAIL_HASHING_VECTORS = Object.freeze([
  { raw: '  Name@Example.COM ', normalisesTo: 'name@example.com' },
] as const)

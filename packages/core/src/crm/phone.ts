/**
 * The CRM's contact key: one number, one key, including the numbers the OTP path will not send to.
 *
 * ## Why this is not a second normaliser
 *
 * `identity/normalise-phone.ts` (B-LIFE-02) already answers the question this business turns on —
 * *what is the canonical form of a UAE mobile number* — and it is the only thing that answers it here.
 * {@link crmPhoneKey} delegates every UAE decision to `normalisePhoneResult` and adds exactly one
 * thing: what to do with a number that carries a country code which is **not** 971.
 *
 * That addition is needed because the two modules answer different questions. B-LIFE-02 answers *can
 * this system send an SMS to this number*, and for a `+44` number the honest answer is no: the
 * business is one premises in Abu Dhabi, the sender id is a UAE one, and a foreign number typed into
 * the booking form is a typo far more often than it is a tourist. The CRM answers *is this the same
 * person as that row*, and for that question a tourist's `+44` number is both usable and important:
 * the record imported from the paper diary and the record created at the desk carry the same foreign
 * number, and refusing to key it means the duplicate is invisible on the only signal it has.
 *
 * So the country code is **kept as typed** rather than replaced, and nothing here guesses one. A
 * number written with no international prefix at all and no UAE shape is refused rather than assumed
 * to be local: assuming would key a Saudi mobile as a UAE one, which is not a near-miss but a
 * different person, and a guessed key is indistinguishable from a derived one once it is in a column.
 *
 * ## What is deliberately still refused
 *
 * A UAE landline or toll-free number comes back as `landline_not_an_sms_target`, B-LIFE-02's reason,
 * unchanged. This module does not re-classify it: the CRM would have to hold a second opinion about
 * UAE number shapes to do that, and the day the two opinions disagreed the merge would stop finding
 * duplicates with no test failing. A contact whose only number is a landline therefore has no phone
 * key, {@link crmPhoneKey} says why by name, and `duplicate-score.ts` scores that pair on its label
 * alone — under the `unknown` phone class, which is the class that can never reach the auto-merge
 * threshold. A missed duplicate is recoverable; a merge of two people is not.
 */
import {
  type E164,
  normalisePhoneResult,
  PHONE_REJECTIONS,
  type PhoneRejection,
  phoneMatchKey,
  phoneTokens,
} from '../identity/normalise-phone.ts'

/**
 * Where the key's country code came from.
 *
 * `foreign` does not name a country and never will: identifying one needs the ITU calling-code table,
 * nothing in this unit reads it, and a country inferred from a prefix is a fact about a person that
 * nobody supplied (brief rule 15). What the caller gets is the guarantee that matters — the digits it
 * typed are the digits in the key.
 */
export const CRM_PHONE_ORIGINS = ['uae', 'foreign'] as const
export type CrmPhoneOrigin = (typeof CRM_PHONE_ORIGINS)[number]

/**
 * Every reason a contact number cannot be keyed, as a value.
 *
 * The first four are B-LIFE-02's, passed through unchanged so that a caller sees one vocabulary
 * rather than two names for one refusal. `unsupported_country` is deliberately absent: it is the one
 * reason this module *answers* instead of forwarding. `phone.test.ts` asserts the pass-through set
 * is complete, so a reason added to B-LIFE-02 cannot quietly disappear here.
 */
export const CRM_PHONE_REJECTIONS = [
  'empty',
  'not_digits',
  'landline_not_an_sms_target',
  'wrong_length',
  /**
   * An international prefix followed by a `0`, which no country code begins with — `+0044…`, a paste
   * that kept one prefix too many. A number written with no prefix at all and no UAE shape comes back
   * as B-LIFE-02's `wrong_length`, because the shape is its judgement and not this module's.
   */
  'no_country_code',
  /** Outside E.164's own limits, so it is a typo rather than a number. */
  'implausible_length',
] as const
export type CrmPhoneRejection = (typeof CRM_PHONE_REJECTIONS)[number]

/** The reasons {@link crmPhoneKey} forwards from B-LIFE-02 rather than deciding for itself. */
export const DELEGATED_PHONE_REJECTIONS: readonly PhoneRejection[] = PHONE_REJECTIONS.filter(
  (reason): reason is Exclude<PhoneRejection, 'unsupported_country'> =>
    reason !== 'unsupported_country',
)

/**
 * E.164's own bounds on the digits after the `+`, and why the floor is 8 rather than 1.
 *
 * The ceiling is the standard's: fifteen digits, country code included. The floor is a judgement —
 * the shortest numbers in service anywhere are seven or eight digits including the country code — and
 * it is here because the alternative is keying `+4412` as a contact. Something that short is a
 * truncated paste, and a key built from it would collide every other truncated paste in the table.
 */
const MIN_E164_DIGITS = 8
const MAX_E164_DIGITS = 15

export interface CrmPhoneKeyed {
  readonly ok: true
  /** Canonical E.164. For a UAE number this is exactly what `normalisePhone` produces. */
  readonly e164: E164
  /** B-LIFE-02's merge candidate key: the trailing nine digits. Indexed, never unique. */
  readonly matchKey: string
  readonly origin: CrmPhoneOrigin
}

export type CrmPhoneNormalisation =
  | CrmPhoneKeyed
  | { readonly ok: false; readonly reason: CrmPhoneRejection }

/**
 * Keys a contact number for duplicate detection, or says by name why it cannot.
 *
 * Non-throwing, because every caller is either scoring a pair or building a candidate probe and a
 * number it cannot key is an ordinary input in both.
 */
export function crmPhoneKey(raw: string): CrmPhoneNormalisation {
  const uae = normalisePhoneResult(raw)
  if (uae.ok) {
    return { ok: true, e164: uae.e164, matchKey: phoneMatchKey(uae.e164), origin: 'uae' }
  }
  if (uae.reason !== 'unsupported_country') return { ok: false, reason: uae.reason }

  // `unsupported_country` is reached only when the caller wrote `+` or `00` and the country code is
  // not 971, so the digits below are already known to be digits and to carry a country code.
  const { digits } = phoneTokens(raw)
  // A leading zero after the international prefix is not a country code — `+0044…` is a paste that
  // kept one prefix too many. Keying it would put the same person under two different keys.
  if (digits.startsWith('0')) return { ok: false, reason: 'no_country_code' }
  if (digits.length < MIN_E164_DIGITS || digits.length > MAX_E164_DIGITS) {
    return { ok: false, reason: 'implausible_length' }
  }
  const e164 = `+${digits}` as E164
  return { ok: true, e164, matchKey: phoneMatchKey(e164), origin: 'foreign' }
}

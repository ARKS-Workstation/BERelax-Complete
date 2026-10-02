/**
 * E.164 for IDENTITY, which is not the same question as E.164 for sending (H-MIG-04).
 *
 * ## Why this exists beside `normalise-phone.ts` rather than inside it
 *
 * `normalisePhoneResult` answers **"can a code be sent to this number"**. It is the booking form's and the
 * OTP path's question, and it is right to refuse a landline there: an OTP sent to a landline is a customer
 * waiting for a message that is never coming, which is why `landline_not_an_sms_target` is one of its
 * named rejections.
 *
 * This module answers a different question: **"what is this number, canonically"**. H-MIG-04 imports a
 * customer list rebuilt from phone contacts and WhatsApp threads, and its own acceptance names two local
 * Abu Dhabi spellings that must both normalise: a mobile written with its trunk prefix, and a LANDLINE
 * written with its area code. (Both are the business's own numbers from docs/13 §3 — the prototype
 * WhatsApp candidate and `PREMISES_NAP.phoneLandline` — so they are spelled out in `./e164.test.ts` and
 * deliberately not here: `premises.test.ts`'s `nap-literal-outside-the-seed` rule keeps a NAP literal out
 * of every shipped module, and a number in a doc comment is a number somebody copies.)
 *
 * A customer whose contact number is the landline of their office is still a customer, their record is
 * still keyed on the number (ADR 0014), and `customer.phone_e164`'s CHECK is a shape check that accepts an
 * eight-digit landline national number behind `+971` perfectly happily. Refusing to import them because
 * nothing can text them would drop real customers out of the list; importing them with the number guessed
 * into mobile shape would put a balance on somebody else's record.
 *
 * So the two answers are separated: this one produces the canonical form AND says whether the number can
 * be messaged, and the messaging decision stays with the messaging layer. The alternative — widening
 * `normalisePhoneResult` to accept a landline — was considered and is the dangerous one: every caller of
 * that function today is a send path or an OTP path, and the change would silently make all of them
 * attempt an SMS to a landline.
 *
 * ## What is shared and what is not
 *
 * The digit FOLDING is shared: {@link phoneTokens} in `./normalise-phone.ts` handles Arabic-Indic and
 * extended Arabic-Indic digits, non-breaking spaces out of a WhatsApp paste, and the `00`/`+`
 * international prefixes. A second copy of that folding here is the defect `phoneTokens` was exported to
 * prevent — `crm/phone.ts` exists so there are two readings of a UAE number in this repository and not
 * three, and this is not a third.
 *
 * The VERDICT is not shared, and `identityAgreesWithSendNormaliser` is the check that holds the two
 * functions in the ONE relationship they are allowed to have: for any input, either both refuse with the
 * same named reason, or they produce the SAME `+971…` string, or `normalisePhoneResult` refuses it for
 * being a landline and this accepts it as one. Anything else is a drift, and `e164.test.ts` asserts it
 * over a census rather than trusting this paragraph.
 *
 * ## Why `+971` is assumed for a bare local number, and what that assumption cannot do
 *
 * A contact list typed in Abu Dhabi writes `050 510 8633`, not `+971 50 510 8633`. H-MIG-04's manifest
 * entry records `+971 assumed as the default country for local-format numbers` as provisional, and this is
 * where the assumption lives. It applies ONLY to a number with no international prefix: `+44…` and
 * `0044…` are `unsupported_country` and are never repaired into a UAE number, because the business is one
 * premises in Abu Dhabi and a foreign number in this column is a typo far more often than it is a tourist
 * — and the one thing an importer may not do is decide which customer a balance belongs to by guessing a
 * country code.
 */
import { AppError } from '@berelax/shared'
import {
  type E164,
  type PhoneRejection,
  phoneTokens,
  UAE_COUNTRY_CODE,
  UAE_LANDLINE_AREA_CODES,
} from './normalise-phone.ts'

/** National significant number length for a mobile: `5` plus eight subscriber digits. */
const MOBILE_NSN_LENGTH = 9
/** Area code plus seven subscriber digits. */
const LANDLINE_NSN_LENGTH = 8

/**
 * What kind of line a canonical number is, which is what decides whether anything can be SENT to it.
 *
 * `toll_free` is kept apart from `landline` although neither can be messaged, because the two say
 * different things about the row: a landline in a contact list is somebody's office, and an `800` number
 * is the business's own support line pasted into the wrong column. An importer that reported both as
 * "landline" would send whoever reads the quarantine report looking for a customer.
 */
export const UAE_LINE_TYPES = ['mobile', 'landline', 'toll_free'] as const
export type UaeLineType = (typeof UAE_LINE_TYPES)[number]

/**
 * Why a cell could not be turned into a canonical number.
 *
 * Deliberately the SAME four spellings `PHONE_REJECTIONS` uses for the same four conditions, and
 * deliberately missing the fifth: `landline_not_an_sms_target` is not a rejection here, it is an answer.
 * Sharing the spellings means a quarantine reason and a booking-form refusal name the same fault in the
 * same words, which is what lets one person read both.
 */
export const E164_IDENTITY_REJECTIONS = [
  'empty',
  'not_digits',
  'unsupported_country',
  'wrong_length',
] as const
export type E164IdentityRejection = (typeof E164_IDENTITY_REJECTIONS)[number]

export const isE164IdentityRejection = (value: string): value is E164IdentityRejection =>
  (E164_IDENTITY_REJECTIONS as readonly string[]).includes(value)

export type E164Identity =
  | {
      readonly ok: true
      readonly e164: E164
      readonly lineType: UaeLineType
      /** False for a landline and a toll-free line. The messaging layer's input, never this module's. */
      readonly messageable: boolean
    }
  | { readonly ok: false; readonly reason: E164IdentityRejection }

/**
 * The shape a number must have before any table in this system will hold it.
 *
 * It mirrors `customer_phone_is_e164` in migration 0019 — `+`, a non-zero digit, then seven to fourteen
 * more — and it is NOT `phoneSchema.shape.e164` in `@berelax/shared`, which is `/^\+\d{7,15}$/` and is
 * one digit looser at the short end. The difference is reachable: `+971800` is what the trunk-prefix
 * branch below makes of a four-character cell reading `0800`, it satisfies the zod shape and the database
 * refuses it. A number this module declared canonical and `customer` would not store is the worst failure
 * available here, because the refusal arrives at the INSERT, a thousand rows into an import, naming a
 * constraint instead of the cell.
 *
 * Stated here rather than imported because the authority is the COLUMN and neither spelling can read SQL.
 * `packages/fixtures/src/customer-import.itest.ts` pushes the whole census of numbers this module accepts
 * through the real column inside a rolled-back transaction, which is the check that holds the two equal
 * (and which also covers the leading-digit rule, invisible to a `+971` number).
 */
const STORABLE_E164 = /^\+[1-9]\d{7,14}$/

/**
 * One canonical answer, with the storability guard every accepting branch goes through.
 *
 * The guard is HERE and not at each call site for the reason the three `lineType` branches exist at all:
 * `8` opens the toll-free and short-code range, whose members have no single length, so that branch cannot
 * carry a length rule of its own and is the one that would otherwise produce an unstorable number.
 */
const accept = (nsn: string, lineType: UaeLineType): E164Identity => {
  const e164 = `+${UAE_COUNTRY_CODE}${nsn}`
  if (!STORABLE_E164.test(e164)) return { ok: false, reason: 'wrong_length' }
  return { ok: true, e164: e164 as E164, lineType, messageable: lineType === 'mobile' }
}

/**
 * Classifies a national significant number, which is the only place the UAE numbering plan is read.
 *
 * `8` is classified on the leading digit alone, with no length rule: the toll-free and short-code range
 * holds `800 xxxx`, `600 5xxxxxx` and shorter codes, and reporting one of those as `wrong_length` would
 * describe the cell rather than the number. {@link accept} is what stops that tolerance producing a
 * number nothing can store.
 */
function classify(nsn: string): E164Identity {
  const first = nsn.slice(0, 1)
  if (first === '5') {
    return nsn.length === MOBILE_NSN_LENGTH
      ? accept(nsn, 'mobile')
      : { ok: false, reason: 'wrong_length' }
  }
  if (first === '8') return accept(nsn, 'toll_free')
  if ((UAE_LANDLINE_AREA_CODES as readonly string[]).includes(first)) {
    return nsn.length === LANDLINE_NSN_LENGTH
      ? accept(nsn, 'landline')
      : { ok: false, reason: 'wrong_length' }
  }
  return { ok: false, reason: 'wrong_length' }
}

/**
 * Turns any accepted spelling of a UAE number into its canonical E.164 form, or says why it will not.
 *
 * Non-throwing, because its first caller stages a two-thousand-line contact list and a cell it cannot read
 * is a row to QUARANTINE rather than an exception to stop the import with. {@link e164Identity} is the
 * throwing form, for the call sites where an unreadable number is a bug.
 */
export function e164IdentityResult(raw: string): E164Identity {
  const { digits, international } = phoneTokens(raw)
  if (digits.length === 0) return { ok: false, reason: 'empty' }
  if (!/^\d+$/.test(digits)) return { ok: false, reason: 'not_digits' }

  if (digits.startsWith(UAE_COUNTRY_CODE)) {
    // `971` in front of nine or eight digits is the country code; in front of seven it is a Fujairah
    // landline (area code 9) written without its trunk prefix. Length decides, exactly as it does in
    // `normalisePhoneResult`, which is why the two cannot disagree about `9715…`.
    const rest = digits.slice(UAE_COUNTRY_CODE.length)
    if (rest.length === MOBILE_NSN_LENGTH || rest.length === LANDLINE_NSN_LENGTH) {
      return classify(rest)
    }
    if (international) return { ok: false, reason: 'wrong_length' }
  }

  // Another country's number. Never repaired into a UAE one — see the module note on what the `+971`
  // assumption is not allowed to do.
  if (international) return { ok: false, reason: 'unsupported_country' }

  // The trunk prefix, which is how every number is written on a card, a sign and a WhatsApp message in
  // this country and is not part of the E.164 form.
  return classify(digits.startsWith('0') ? digits.slice(1) : digits)
}

/** The throwing form, for a call site where an unreadable number is a bug rather than a row. */
export function e164Identity(raw: string): E164 {
  const result = e164IdentityResult(raw)
  if (!result.ok) {
    throw new AppError(
      'validation',
      `"${raw}" is not a UAE number this system can key a record on (${result.reason}). ` +
        'Use e164IdentityResult where an unreadable cell is data rather than a defect.',
      { details: { reason: result.reason } },
    )
  }
  return result.e164
}

/**
 * The relationships this module and `normalisePhoneResult` are allowed to have, as a value.
 *
 * Returned rather than asserted so the census that proves it lives in a test and the rule lives here. The
 * two DANGEROUS directions are what the single `disagree` verdict covers, and they are worth naming
 * because neither would announce itself: an identity this module accepts and the send path cannot parse is
 * a customer record nothing can ever message, and an identity this module refuses and the booking form
 * accepts is one person with two records — the failure `./normalise-phone.ts` opens by describing.
 *
 *   - `same` — both produced the same canonical number, or both refused with the same named reason;
 *   - `identity_only` — the send normaliser refused it as `landline_not_an_sms_target` and this module
 *     accepted it as a line that cannot be messaged. The one case the two are MEANT to differ on;
 *   - `both_refuse` — the send normaliser refused it as a landline AND this module refused it too. Only
 *     reachable through that branch, and it is the verdict the census itself found: `0800` is an
 *     unsendable line to the send normaliser and an unstorable number here, so both refuse and only the
 *     WORD differs. Separated from `same` rather than folded into it, because the two reasons are about
 *     different things and a reader of the quarantine report is owed the one that applies;
 *   - `disagree` — anything else.
 */
export function identityAgreesWithSendNormaliser(
  identity: E164Identity,
  send:
    | { readonly ok: true; readonly e164: E164 }
    | { readonly ok: false; readonly reason: string },
): 'same' | 'identity_only' | 'both_refuse' | 'disagree' {
  if (send.ok) {
    return identity.ok && identity.e164 === send.e164 && identity.messageable ? 'same' : 'disagree'
  }
  if (send.reason === ('landline_not_an_sms_target' satisfies PhoneRejection)) {
    if (!identity.ok) return 'both_refuse'
    return identity.messageable ? 'disagree' : 'identity_only'
  }
  return !identity.ok && identity.reason === send.reason ? 'same' : 'disagree'
}

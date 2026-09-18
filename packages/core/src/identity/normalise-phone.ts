/**
 * Phone-first identity: one number, one canonical form, and the match keys a merge is built on.
 *
 * ADR 0014 is the whole reason this module exists. Customers have no accounts; the phone number *is*
 * the identity. So `050 510 8633`, `0505108633`, `971 50 510 8633` and `+971505108633` are not four
 * spellings of a string — they are four spellings of **one person**, and if they resolve to four rows
 * then that person's booking history, package balance, contraindication flags and marketing consent
 * split four ways and nobody notices until a therapist reads the wrong flags.
 *
 * Normalisation therefore happens at the boundary and the stored form is canonical E.164. Everything
 * downstream — the UNIQUE index on `customer.phone_e164`, the dedup match keys, the OTP challenge —
 * keys on what this function returns and never on what was typed.
 *
 * ## Why a shape test and not an allocated-prefix test
 *
 * The UAE's allocated mobile prefixes are 50, 52, 54, 55, 56 and 58 ({@link UAE_MOBILE_PREFIXES}).
 * It is tempting to reject everything else, and it is wrong twice over. The fixture numbers are on
 * `59` precisely *because* it is unallocated and therefore undialable
 * (`packages/fixtures/src/synthetic.ts`), so an allocated-prefix rule would reject every synthetic
 * customer in the system while catching nothing real; and the TDRA allocates new prefixes without
 * asking us, so the rule would start rejecting genuine customers on a date nobody can predict.
 *
 * What this module rejects instead is a number of the wrong *shape* — a landline, a toll-free line, a
 * short code — because those cannot receive an SMS at all and an OTP sent to one is a customer
 * waiting for a message that is never coming. That distinction is the named rejection
 * `landline_not_an_sms_target`.
 *
 * ## Why the rejection reasons are named values rather than message strings
 *
 * The API route turns a rejection into a response, and a message string is not something a route can
 * branch on without matching on prose. Every rejection is one of {@link PHONE_REJECTIONS}, carried on
 * {@link PhoneNormalisationError.reason} and asserted by name in the tests — a reason nobody can
 * assert on is a reason that quietly changes meaning.
 */
import { AppError, type Brand } from '@berelax/shared'

/** A phone number in E.164, `+` then digits. The only form this system stores. */
export type E164 = Brand<string, 'E164'>

export const UAE_COUNTRY_CODE = '971'

/**
 * Mobile prefixes actually allocated in the UAE, for display and for the OTP-target table test.
 *
 * Deliberately **not** used as an accept-list; see the module note. `packages/fixtures` keeps its own
 * copy for the opposite purpose — proving a fixture number is *not* on one of these.
 */
export const UAE_MOBILE_PREFIXES = ['50', '52', '54', '55', '56', '58'] as const

/**
 * Landline area codes, and the reason they are enumerated rather than inferred.
 *
 * A UAE landline is an area code plus seven digits, and the area codes are 2, 3, 4, 6, 7 and 9. `5`
 * is mobile and `8` opens the toll-free and short-code range. Enumerating them means a national
 * number that matches none of these is reported as `wrong_length` rather than being silently accepted
 * as a mobile.
 */
export const UAE_LANDLINE_AREA_CODES = ['2', '3', '4', '6', '7', '9'] as const

/** National significant number length: `5` plus eight subscriber digits. */
const MOBILE_NSN_LENGTH = 9
/** Area code plus seven subscriber digits. */
const LANDLINE_NSN_LENGTH = 8

export const PHONE_REJECTIONS = [
  'empty',
  'not_digits',
  'unsupported_country',
  'landline_not_an_sms_target',
  'wrong_length',
] as const
export type PhoneRejection = (typeof PHONE_REJECTIONS)[number]

/** Thrown by {@link normalisePhone}. Carries the reason as a value, not as prose. */
export class PhoneNormalisationError extends AppError {
  readonly reason: PhoneRejection

  constructor(reason: PhoneRejection, message: string, details: Record<string, unknown>) {
    super('validation', message, { userFacing: true, details: { ...details, reason } })
    this.name = 'PhoneNormalisationError'
    this.reason = reason
  }
}

export type PhoneNormalisation =
  | { readonly ok: true; readonly e164: E164 }
  | { readonly ok: false; readonly reason: PhoneRejection }

/**
 * Digits as they are actually typed on an Arabic keyboard.
 *
 * `٠٥٠` and `050` are the same number to the person entering it, and an Arabic-locale booking form is
 * half of this product. Mapping them here rather than in the form means every entry point agrees —
 * the alternative is a customer who books in Arabic getting a second customer record.
 */
const DIGIT_TRANSLITERATIONS: ReadonlyMap<string, string> = new Map([
  // Arabic-Indic, U+0660..U+0669.
  ...'٠١٢٣٤٥٦٧٨٩'.split('').map((char, value): [string, string] => [char, String(value)]),
  // Extended Arabic-Indic (Persian/Urdu keyboards), U+06F0..U+06F9.
  ...'۰۱۲۳۴۵۶۷۸۹'.split('').map((char, value): [string, string] => [char, String(value)]),
])

/**
 * Separators a human puts in a phone number, removed before anything is parsed.
 *
 * `\s` is doing more work here than it looks: in JavaScript it matches the whole Unicode whitespace
 * set, including U+00A0 and U+202F. That matters because a number pasted out of WhatsApp or a PDF
 * arrives with non-breaking spaces in it — indistinguishable from a space on screen, and a
 * different string. Spelling those codepoints out as literals here would put invisible characters in
 * source, a hazard of its own (scripts/check-invisible-chars.mjs); `\s` covers them and stays legible.
 */
const SEPARATORS = /[\s()[\].\-–—/]/g

function transliterateDigits(input: string): string {
  let out = ''
  for (const char of input) out += DIGIT_TRANSLITERATIONS.get(char) ?? char
  return out
}

/**
 * Reduces any accepted spelling to `+`-less digits plus a flag for an explicit international prefix.
 *
 * `00` and `+` mean the same thing and both mean "what follows is a country code", which matters:
 * without that flag, `00971...` and `0971...` are indistinguishable and one of them is a Dubai
 * landline with an extra digit.
 */
function tokenise(raw: string): { digits: string; international: boolean } {
  const compact = transliterateDigits(raw).replace(SEPARATORS, '')
  if (compact.startsWith('+')) return { digits: compact.slice(1), international: true }
  if (compact.startsWith('00')) return { digits: compact.slice(2), international: true }
  return { digits: compact, international: false }
}

function classifyNsn(nsn: string): PhoneNormalisation {
  const first = nsn.slice(0, 1)
  if (first === '5' && nsn.length === MOBILE_NSN_LENGTH) {
    return { ok: true, e164: `+${UAE_COUNTRY_CODE}${nsn}` as E164 }
  }
  // A landline or a toll-free line is a valid UAE number and a hopeless SMS target. It gets its own
  // reason so the booking form can say "that number cannot receive a code" instead of "invalid".
  const landline =
    ((UAE_LANDLINE_AREA_CODES as readonly string[]).includes(first) &&
      nsn.length === LANDLINE_NSN_LENGTH) ||
    first === '8'
  if (landline) return { ok: false, reason: 'landline_not_an_sms_target' }
  return { ok: false, reason: 'wrong_length' }
}

/**
 * Normalises any accepted spelling of a UAE mobile number to E.164, or says why it will not.
 *
 * Non-throwing, because the first caller is an HTTP route that turns a rejection into a response
 * body. {@link normalisePhone} is the throwing form for call sites where a bad number is a bug.
 */
export function normalisePhoneResult(raw: string): PhoneNormalisation {
  const { digits, international } = tokenise(raw)
  if (digits.length === 0) return { ok: false, reason: 'empty' }
  if (!/^\d+$/.test(digits)) return { ok: false, reason: 'not_digits' }

  if (digits.startsWith(UAE_COUNTRY_CODE)) {
    // `971` at the front of a 12-digit string is a country code; at the front of an 8-digit one it is
    // a Fujairah landline (area code 9). Length decides, which is why the two are never confused.
    const rest = digits.slice(UAE_COUNTRY_CODE.length)
    if (rest.length === MOBILE_NSN_LENGTH || rest.length === LANDLINE_NSN_LENGTH) {
      return classifyNsn(rest)
    }
    // `+971` and then the wrong number of digits is a UAE number with a typo, not a foreign one.
    // Reporting `unsupported_country` there would send somebody looking for the wrong mistake.
    if (international) return { ok: false, reason: 'wrong_length' }
  }

  if (international) {
    // Another country's number is not something this system can normalise, and guessing is worse than
    // refusing: the business is one premises in Abu Dhabi, and a 44 or 966 number here is a typo far
    // more often than it is a tourist.
    return { ok: false, reason: 'unsupported_country' }
  }

  // The trunk prefix. `0` is how the number is written on every card, sign and WhatsApp message in
  // the country, and it is not part of the E.164 form.
  const nsn = digits.startsWith('0') ? digits.slice(1) : digits
  return classifyNsn(nsn)
}

/** As {@link normalisePhoneResult}, throwing a named error. Use where a bad number is a bug. */
export function normalisePhone(raw: string): E164 {
  const result = normalisePhoneResult(raw)
  if (result.ok) return result.e164
  throw new PhoneNormalisationError(
    result.reason,
    `"${raw}" is not a UAE mobile number this system can send an SMS to (${result.reason}). ` +
      'Identity is the phone number (ADR 0014), so an un-normalised number becomes a second ' +
      'customer record rather than an error anybody sees.',
    { raw },
  )
}

/** True when the number is on a prefix the TDRA has actually allocated to a mobile operator. */
export function isAllocatedUaeMobile(e164: E164): boolean {
  const prefix = e164.slice(`+${UAE_COUNTRY_CODE}`.length, `+${UAE_COUNTRY_CODE}`.length + 2)
  return (UAE_MOBILE_PREFIXES as readonly string[]).includes(prefix)
}

// --- dedup match keys --------------------------------------------------------------------------

/**
 * How many trailing digits the phone match key keeps.
 *
 * Nine, the length of a UAE national significant number. The key exists for the **merge** C-CRM will
 * own, where the input is not always clean E.164: a row imported from the paper diary or from a
 * WhatsApp export may carry no country code at all, and the point of a match key is that such a row
 * still lands next to its twin. `customer.phone_e164` is what UNIQUE is on; this is what a candidate
 * search is on, which is why it is indexed but not unique.
 */
export const PHONE_MATCH_KEY_DIGITS = 9

/** The last four digits, as shown on screen and used in the name match key. */
export const PHONE_TAIL_DIGITS = 4

const digitsOf = (value: string): string => value.replace(/\D/g, '')

/** The merge candidate key for a number: its trailing national significant digits. */
export function phoneMatchKey(e164: E164): string {
  return digitsOf(e164).slice(-PHONE_MATCH_KEY_DIGITS)
}

/** The last four digits. Never the whole number — a masked number is what goes on screen. */
export function phoneTail(e164: E164): string {
  return digitsOf(e164).slice(-PHONE_TAIL_DIGITS)
}

/**
 * Arabic letters that are spelled either way, named rather than written as literals.
 *
 * `unaccent` handles the Latin side of name folding and nothing in Postgres handles the Arabic side,
 * which is half of this customer base. Built from codepoints because two of these are the kind of
 * character a reviewer cannot see in a regex class, and invisible characters in source are their own
 * hazard (ADR 0003's sibling gate, `scripts/check-invisible-chars.mjs`).
 */
const TATWEEL = String.fromCodePoint(0x0640)
const TA_MARBUTA = String.fromCodePoint(0x0629)
const HA = String.fromCodePoint(0x0647)
const ALEF_MAKSURA = String.fromCodePoint(0x0649)
const YA = String.fromCodePoint(0x064a)

/**
 * Reduces a written name to a form two spellings of it can agree on.
 *
 * Lowercased, stripped of Latin accents and Arabic diacritics, punctuation removed, and the remaining
 * words **sorted**. Sorting is the non-obvious half: a customer gives their name given-name-first at
 * the desk and family-name-first on a form, and an unsorted key makes those two records invisible to
 * each other. The cost is that the key cannot be displayed — which is correct, since it is a key.
 */
export function normaliseNameForMatching(name: string): string {
  const folded = name
    .normalize('NFKD')
    // One strip for both scripts. NFKD decomposes the Latin accent into `e` + U+0301 and the Arabic
    // hamza-carrying alef into alef + U+0654, so removing every combining mark folds both — and
    // removes the harakat, which are decoration as far as matching is concerned.
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replaceAll(TATWEEL, '')
    // The two endings people write either way. Neither is a combining mark, so neither is reached by
    // the strip above.
    .replaceAll(TA_MARBUTA, HA)
    .replaceAll(ALEF_MAKSURA, YA)
  return folded
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((token) => token.length > 0)
    .sort()
    .join(' ')
}

/**
 * `normalised-name:last-4`, or null when there is no name to key on.
 *
 * Null rather than a key built from the digits alone, because a name-less key would collide every
 * customer who shares a last-four with every other — which is not a weak match, it is a false one.
 * Therapists and customers alike have no invented names in this system (ADR 0020), so a null name is
 * the ordinary case rather than an edge one.
 */
export function nameMatchKey(name: string | null | undefined, e164: E164): string | null {
  if (name === null || name === undefined) return null
  const normalised = normaliseNameForMatching(name)
  if (normalised.length === 0) return null
  return `${normalised}:${phoneTail(e164)}`
}

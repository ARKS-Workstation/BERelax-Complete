/**
 * SMS encoding and segmentation, per 3GPP TS 23.038.
 *
 * This is not a provider detail. It decides what a campaign costs, and for this business the answer
 * is counter-intuitive enough to be worth computing rather than estimating: **an Arabic message
 * holds 70 characters per segment against English's 160**, because a single Arabic character forces
 * the whole message to UCS-2. The same sentence in two languages is not the same price, and an
 * Arabic campaign runs roughly 2.3x the cost of its English twin.
 *
 * Two traps this exists to avoid. A message that fits in one segment in the compose box and three in
 * the send path — because a customer's name contained an accent. And a `€`, `{` or `[`, which are
 * GSM-7 *extension* characters costing two units each, so a 159-character message with one brace does
 * not fit in one segment.
 *
 * Pure: no I/O.
 */

/** The GSM 03.38 default alphabet. One septet each. */
const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'

/** Reachable only via an escape, so each costs two septets rather than one. */
const GSM7_EXTENDED = '^{}\\[~]|€'

const BASIC = new Set(GSM7_BASIC)
const EXTENDED = new Set(GSM7_EXTENDED)

export type SmsEncoding = 'GSM-7' | 'UCS-2'

export interface SmsSegmentation {
  readonly encoding: SmsEncoding
  /** Billable segments. Zero only for an empty body. */
  readonly segments: number
  /** Units consumed: septets for GSM-7, UTF-16 code units for UCS-2. */
  readonly units: number
  /** Capacity of a single-segment message in this encoding. */
  readonly singleLimit: number
  /** Capacity per segment once the message is concatenated, which is smaller by the UDH header. */
  readonly concatenatedLimit: number
  /** Units still free in the current segment. */
  readonly remaining: number
  /**
   * The characters that forced UCS-2, if any.
   *
   * Surfaced so a composer can say "the ’ in this message costs you 90 characters" rather than
   * silently doubling the bill — a typographic apostrophe pasted from a word processor is the usual
   * culprit.
   */
  readonly forcedBy: readonly string[]
}

const LIMITS = {
  'GSM-7': { single: 160, concatenated: 153 },
  'UCS-2': { single: 70, concatenated: 67 },
} as const

/** Characters outside the GSM-7 alphabet, deduplicated, in order of first appearance. */
function nonGsm7(body: string): string[] {
  const found: string[] = []
  for (const char of body) {
    if (BASIC.has(char) || EXTENDED.has(char)) continue
    if (!found.includes(char)) found.push(char)
  }
  return found
}

/** Septets for a GSM-7 body: one per basic character, two per extension character. */
function gsm7Units(body: string): number {
  let units = 0
  for (const char of body) units += EXTENDED.has(char) ? 2 : 1
  return units
}

/**
 * How a body will actually be sent and billed.
 *
 * UCS-2 length is counted in UTF-16 code units rather than codepoints, because that is what the
 * air interface carries: an emoji outside the BMP is a surrogate pair and occupies two units.
 */
export function segmentSms(body: string): SmsSegmentation {
  const forcedBy = nonGsm7(body)
  const encoding: SmsEncoding = forcedBy.length === 0 ? 'GSM-7' : 'UCS-2'
  const limits = LIMITS[encoding]
  const units = encoding === 'GSM-7' ? gsm7Units(body) : [...body].reduce((n, c) => n + c.length, 0)

  if (units === 0) {
    return {
      encoding,
      segments: 0,
      units: 0,
      singleLimit: limits.single,
      concatenatedLimit: limits.concatenated,
      remaining: limits.single,
      forcedBy,
    }
  }

  const segments = units <= limits.single ? 1 : Math.ceil(units / limits.concatenated)
  const capacity = segments === 1 ? limits.single : segments * limits.concatenated

  return {
    encoding,
    segments,
    units,
    singleLimit: limits.single,
    concatenatedLimit: limits.concatenated,
    remaining: capacity - units,
    forcedBy,
  }
}

/** True when the body would be sent as UCS-2, i.e. at 70 characters per segment. */
export function isUnicodeSms(body: string): boolean {
  return segmentSms(body).encoding === 'UCS-2'
}

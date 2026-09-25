/**
 * Which alphabet an SMS body will actually be sent in, and what each character costs in it.
 *
 * Per 3GPP TS 23.038. This is not a provider detail: it decides what a campaign costs, and for this
 * business the answer is counter-intuitive enough to be worth computing rather than estimating. **An
 * Arabic message holds 70 characters per segment against English's 160**, because a single Arabic
 * character forces the whole body to UCS-2 — docs/04 §5, which asks for exactly this: "Compute
 * encoding, segments and cost at authoring time and show it to whoever writes the copy."
 *
 * Two traps this exists to avoid. A message that fits in one segment in the compose box and three in the
 * send path, because a customer's name contained an accent. And a `€`, `{` or `[`, which are GSM-7
 * *extension* characters costing two septets each, so a 159-character message with one brace does not fit
 * in one segment.
 *
 * ## Why this is the only place the alphabet is written down
 *
 * It used to be in `packages/core/src/text/sms.ts`, where B-MSG-01 put it, and C-AUTO-02 moved it here
 * rather than adding a second copy beside {@link module:segments}. A second alphabet is not a tidiness
 * question: the fake vendor bills from one, the authoring preview would read from the other, and the two
 * would agree until somebody added a character to one of them — at which point the price an author is
 * shown stops being the price the invoice carries, which is the single failure this whole unit exists to
 * prevent.
 *
 * Pure: no I/O, no clock. `Intl` is deliberately not used here; the grapheme walk that needs it lives in
 * `segments.ts` and says why.
 */

/** The GSM 03.38 default alphabet. One septet each. */
export const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'

/** Reachable only via an escape, so each costs two septets rather than one. */
export const GSM7_EXTENDED = '^{}\\[~]|€'

const BASIC = new Set(GSM7_BASIC)
const EXTENDED = new Set(GSM7_EXTENDED)

export type SmsEncoding = 'GSM-7' | 'UCS-2'

/** Every encoding, so a table over them can be proved total rather than assumed to be. */
export const SMS_ENCODINGS = ['GSM-7', 'UCS-2'] as const

export interface SmsCapacity {
  /** Capacity of a single-segment message. */
  readonly single: number
  /** Capacity per segment once concatenated, which is smaller by the UDH header. */
  readonly concatenated: number
}

/**
 * The two capacities, per encoding.
 *
 * `satisfies Record<SmsEncoding, SmsCapacity>` rather than an annotation, so the literals stay literal —
 * a test can assert `SEGMENT_LIMITS['UCS-2'].single === 70` and a third encoding would fail to compile
 * rather than fall into a default.
 */
export const SEGMENT_LIMITS = {
  'GSM-7': { single: 160, concatenated: 153 },
  'UCS-2': { single: 70, concatenated: 67 },
} as const satisfies Record<SmsEncoding, SmsCapacity>

/**
 * Characters outside the GSM-7 alphabet, deduplicated, in order of first appearance.
 *
 * Iterated by code point rather than by UTF-16 unit, so an astral emoji is reported as the one character
 * a person sees rather than as two halves of a surrogate pair that are individually meaningless.
 */
export function nonGsm7Characters(body: string): readonly string[] {
  const found: string[] = []
  for (const char of body) {
    if (BASIC.has(char) || EXTENDED.has(char)) continue
    if (!found.includes(char)) found.push(char)
  }
  return found
}

/** How a body will be sent: GSM-7 unless one character cannot be, in which case all of it is UCS-2. */
export function detectSmsEncoding(body: string): SmsEncoding {
  return nonGsm7Characters(body).length === 0 ? 'GSM-7' : 'UCS-2'
}

/** True when the body would be sent as UCS-2, i.e. at 70 characters per segment rather than 160. */
export function isUnicodeSms(body: string): boolean {
  return detectSmsEncoding(body) === 'UCS-2'
}

/**
 * What a piece of text costs in an encoding, in the units that encoding is billed in.
 *
 * Septets for GSM-7 — one per basic character, **two** per extension character, because an extension
 * character is an escape followed by the character. UTF-16 code units for UCS-2, rather than code
 * points, because that is what the air interface carries: an emoji outside the BMP is a surrogate pair
 * and occupies two units.
 *
 * A character that is in neither GSM-7 set counts as one septet under `GSM-7`. That branch is
 * unreachable through {@link detectSmsEncoding} — a character outside the alphabet is exactly what
 * forces UCS-2 — and it is what the shipped counter did, so it is kept rather than turned into a throw
 * that only a caller passing the wrong encoding could ever see.
 */
export function smsUnitsOf(text: string, encoding: SmsEncoding): number {
  if (encoding === 'UCS-2') return text.length
  let septets = 0
  for (const char of text) septets += EXTENDED.has(char) ? 2 : 1
  return septets
}

/**
 * How many segments a body is, where they break, and what they cost.
 *
 * docs/04 §5 is the requirement: "GSM-7 gives 160 characters per segment; a single Arabic character
 * forces UCS-2 at 70 (67 concatenated). A 'short' 150-character Arabic message is three segments.
 * Compute encoding, segments and cost at authoring time and show it to whoever writes the copy." The
 * alternative to computing it is finding out from an invoice, by which point 2,000 messages have gone.
 *
 * ## Two segment counts, and why both are reported
 *
 * `unitSegments` is the arithmetic: `ceil(units / perSegment)`, which is what a splitter that counts
 * septets and UTF-16 code units and nothing else produces. `segments` is what the body actually breaks
 * into once a surrogate pair and a grapheme cluster are kept whole — and it is sometimes one larger.
 *
 * 67 astral emoji are 134 UTF-16 units, so the arithmetic says two concatenated segments of 67. It cannot
 * be done: 67 is odd, so the 34th emoji would be split down the middle of its surrogate pair and both
 * halves would render as replacement characters — on a customer's handset, in a message they were sent
 * on purpose. A sender that composes its own parts therefore fits 33 emoji per segment and needs three,
 * and `segments` is that number because it is the one that will be sent and billed. `unitSegments` is
 * kept beside it, and {@link SmsSegmentation.clusterCostsAnExtraSegment} names the difference, because a
 * preview whose number silently exceeded the vendor's arithmetic would look like a bug in this file.
 *
 * ## Why the chunks differ by encoding
 *
 * A GSM-7 body has no grapheme clusters worth the name: every character of the 03.38 alphabet is one
 * code point, and the only indivisible pair is the escape plus the extension character it introduces —
 * which is one code point costing two septets. So GSM-7 packs code points, and needs no segmenter.
 * UCS-2 packs grapheme clusters, because that is where combining marks, variation selectors, regional
 * indicators and ZWJ sequences live, and splitting one of those produces a different visible character
 * rather than a broken one. One packer over both, so there is no second reading of "does this fit".
 *
 * Pure: no I/O, no clock. `Intl.Segmenter` is a deterministic function of its input — it is the same
 * table lookup `Intl.NumberFormat` is in `money.ts` — and the locale is stated rather than defaulted, so
 * the split cannot depend on the environment's language.
 */
import { fils, type Money, money, multiply } from '../money.ts'
import {
  detectSmsEncoding,
  nonGsm7Characters,
  SEGMENT_LIMITS,
  type SmsEncoding,
  smsUnitsOf,
} from './encoding.ts'

/**
 * The grapheme walker.
 *
 * `'en'` explicitly, and not the default locale: grapheme segmentation is the same UAX #29 table in every
 * locale ICU ships, but an `undefined` locale argument makes the result depend on the environment, and
 * "the preview said two segments on the front-desk machine and three in CI" is not a failure anybody
 * would trace back to here. Constructed once, because constructing one per keystroke is the expensive
 * part.
 */
const GRAPHEMES = new Intl.Segmenter('en', { granularity: 'grapheme' })

export interface SmsSegmentation {
  readonly encoding: SmsEncoding
  /** Billable segments, keeping clusters whole. Zero only for an empty body. */
  readonly segments: number
  /** Units consumed: septets for GSM-7, UTF-16 code units for UCS-2. */
  readonly units: number
  /** Capacity of a single-segment message in this encoding. */
  readonly singleLimit: number
  /** Capacity per segment once the message is concatenated, which is smaller by the UDH header. */
  readonly concatenatedLimit: number
  /** Units still free across the segments this body occupies. */
  readonly remaining: number
  /**
   * The characters that forced UCS-2, if any.
   *
   * Surfaced so a composer can say "the ’ in this message costs you 90 characters" rather than silently
   * doubling the bill — a typographic apostrophe pasted from a word processor is the usual culprit.
   */
  readonly forcedBy: readonly string[]
  /** `ceil(units / perSegment)`: the count from unit arithmetic alone, ignoring cluster boundaries. */
  readonly unitSegments: number
  /** True when keeping a cluster whole costs a segment the unit arithmetic does not charge for. */
  readonly clusterCostsAnExtraSegment: boolean
  /** The payloads, in order. Concatenating them returns the body exactly. */
  readonly parts: readonly string[]
  /**
   * Clusters that no segment can hold, and were therefore split by code point.
   *
   * Not a hypothetical: a combining sequence can be arbitrarily long, and 67 UTF-16 units is reachable
   * by hand. A split there is unavoidable rather than a choice — so it is **named** instead of being
   * done quietly, and a surrogate pair is still never broken, because a code point is atomic.
   */
  readonly splitClusters: readonly string[]
}

/** The indivisible pieces of a body in an encoding, in order. Concatenated, they are the body. */
function chunksOf(body: string, encoding: SmsEncoding): readonly string[] {
  if (encoding === 'GSM-7') return [...body]
  return [...GRAPHEMES.segment(body)].map((piece) => piece.segment)
}

interface PackResult {
  readonly parts: readonly string[]
  readonly splitClusters: readonly string[]
}

/** Greedily fills segments of `limit` units, never breaking a chunk unless no segment could hold it. */
function pack(chunks: readonly string[], limit: number, encoding: SmsEncoding): PackResult {
  const parts: string[] = []
  const splitClusters: string[] = []
  let current = ''
  let used = 0
  const flush = (): void => {
    if (current !== '') parts.push(current)
    current = ''
    used = 0
  }
  const place = (chunk: string): void => {
    const cost = smsUnitsOf(chunk, encoding)
    if (used + cost > limit) flush()
    current += chunk
    used += cost
  }
  for (const chunk of chunks) {
    if (smsUnitsOf(chunk, encoding) > limit) {
      // No segment can hold this cluster whole, so the only question is where it breaks. Code points,
      // because a code point is the smallest thing that renders at all: splitting one would put half a
      // surrogate pair in each segment and produce two replacement characters out of one emoji.
      splitClusters.push(chunk)
      for (const codePoint of chunk) place(codePoint)
      continue
    }
    place(chunk)
  }
  flush()
  return { parts, splitClusters }
}

/**
 * How a body will actually be sent and billed.
 *
 * The single-segment case is answered first and separately, because the capacity is larger: a message
 * that fits in 160 septets carries no UDH header, and testing it against the concatenated limit of 153
 * would report two segments for a 155-character message that is one.
 */
export function segmentSms(body: string): SmsSegmentation {
  const forcedBy = nonGsm7Characters(body)
  const encoding = detectSmsEncoding(body)
  const limits = SEGMENT_LIMITS[encoding]
  const units = smsUnitsOf(body, encoding)

  if (units === 0) {
    return {
      encoding,
      segments: 0,
      units: 0,
      singleLimit: limits.single,
      concatenatedLimit: limits.concatenated,
      remaining: limits.single,
      forcedBy,
      unitSegments: 0,
      clusterCostsAnExtraSegment: false,
      parts: [],
      splitClusters: [],
    }
  }

  const unitSegments = units <= limits.single ? 1 : Math.ceil(units / limits.concatenated)
  const packed =
    units <= limits.single
      ? { parts: [body], splitClusters: [] as readonly string[] }
      : pack(chunksOf(body, encoding), limits.concatenated, encoding)
  const segments = packed.parts.length
  const capacity = segments === 1 ? limits.single : segments * limits.concatenated

  return {
    encoding,
    segments,
    units,
    singleLimit: limits.single,
    concatenatedLimit: limits.concatenated,
    remaining: capacity - units,
    forcedBy,
    unitSegments,
    clusterCostsAnExtraSegment: segments > unitSegments,
    parts: packed.parts,
    splitClusters: packed.splitClusters,
  }
}

/** The payloads a body breaks into, for a caller that wants the parts and not the arithmetic. */
export function splitSmsSegments(body: string): readonly string[] {
  return segmentSms(body).parts
}

// --- what a segment costs ----------------------------------------------------------------------

/**
 * The SMS vendors this table prices.
 *
 * One, because one is contracted: SMSala (docs/05 §1). A key with no row is a compile error rather than
 * a lookup that returns `undefined` and multiplies to `NaN`, which is the shape of a cost report that
 * reads as free.
 */
export const SMS_PRICE_PROVIDERS = ['smsala'] as const
export type SmsPriceProvider = (typeof SMS_PRICE_PROVIDERS)[number]

export interface SmsProviderPrices {
  /** Fils per segment, by encoding. VAT-inclusive gross like every other figure (ADR 0007). */
  readonly perSegment: Readonly<Record<SmsEncoding, Money>>
  /** The OPEN-QUESTIONS id that replaces these numbers with the contracted rate. */
  readonly provisionalUntil: string
  readonly why: string
}

/**
 * The price table. **Provisional**, and the marker is a field rather than a comment.
 *
 * `Y6-sms-rate` in docs/OPEN-QUESTIONS.md is open: nobody has seen an SMSala contract, so both numbers
 * are placeholders that a rate card replaces. They are carried in the type so that every figure derived
 * from them can say so on screen — an unqualified "AED 6.00" on a campaign screen is indistinguishable
 * from a quoted price, and brief rule 15 is about exactly that.
 *
 * The two numbers are **different on purpose**, beyond being what the manifest allocated. A single rate
 * for both encodings makes "the cost is priced per encoding" unfalsifiable: a calculator that looked the
 * encoding up and then ignored it would produce the same total, and every test of it would pass (brief
 * rule 3). With 12 and 30 the lookup is load-bearing, and the Arabic multiple this business actually
 * faces — three segments at the UCS-2 rate against one at the GSM-7 rate, so 7.5x rather than docs/04's
 * capacity-only 2.3x — is on screen at authoring time instead of on the invoice.
 */
export const SMS_SEGMENT_PRICES = {
  smsala: {
    perSegment: {
      // `money(fils(n))` and not a bare number: money is integer fils, and `fils(12.5)` is a **type**
      // error rather than a runtime one (F05). A rate card arriving as "AED 0.125" is the exact input
      // that would otherwise land a float in a price table and a fraction of a fils on a cost report.
      'GSM-7': money(fils(12)),
      'UCS-2': money(fils(30)),
    },
    provisionalUntil: 'Y6-sms-rate',
    why:
      'Provisional. No SMSala rate card is on file, and the unicode rate is quoted separately by every ' +
      'aggregator that publishes one, so the table is keyed by encoding rather than flattened to one ' +
      'number that would have to be split again later.',
  },
} as const satisfies Record<SmsPriceProvider, SmsProviderPrices>

/** Fils per segment for one provider and encoding. Total by construction: neither key can be missing. */
export function smsSegmentPrice(provider: SmsPriceProvider, encoding: SmsEncoding): Money {
  return SMS_SEGMENT_PRICES[provider].perSegment[encoding]
}

export interface SmsCostPreview {
  readonly provider: SmsPriceProvider
  readonly segmentation: SmsSegmentation
  /** Fils per segment, from the table. */
  readonly unitPrice: Money
  /** `unitPrice * segments`, exactly. Integer fils, so there is nothing to round. */
  readonly total: Money
  /** The OPEN-QUESTIONS id, carried so a screen showing the total can qualify it. */
  readonly provisionalUntil: string
}

/**
 * What one body costs to send once, with the segmentation it was priced from.
 *
 * The segmentation travels with the money deliberately: "AED 0.90" on its own invites the reader to
 * assume a long message, and the number that changes a decision is "three segments, because it is
 * Arabic".
 */
export function smsCost(provider: SmsPriceProvider, body: string): SmsCostPreview {
  const segmentation = segmentSms(body)
  const unitPrice = smsSegmentPrice(provider, segmentation.encoding)
  return {
    provider,
    segmentation,
    unitPrice,
    // `multiply` refuses a fractional quantity, and a segment count is always an integer, so the total
    // is exact rather than rounded. `segments` and not `unitSegments`: the parts that will be sent.
    total: multiply(unitPrice, segmentation.segments),
    provisionalUntil: SMS_SEGMENT_PRICES[provider].provisionalUntil,
  }
}

/**
 * The cost of sending one body to many recipients — the figure a campaign screen has to show before
 * somebody presses send.
 *
 * `recipients` is checked rather than trusted, by `multiply`, which refuses a quantity that is not a
 * whole number. The count that arrives here is a row count and cannot be fractional — which is exactly
 * why a fractional one must throw rather than be rounded: it means the caller handed over an average, a
 * proportion or a figure it divided, and the screen whose whole purpose is to state a cost in advance
 * would otherwise state one nobody could reconcile.
 */
export function smsCampaignCost(
  provider: SmsPriceProvider,
  body: string,
  recipients: number,
): Money {
  return multiply(smsCost(provider, body).total, recipients)
}

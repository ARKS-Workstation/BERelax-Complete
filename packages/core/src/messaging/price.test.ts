import { describe, expect, it } from 'vitest'
import { fils, type IntegerLiteral, money } from '../money.ts'
import { SMS_ENCODINGS } from './encoding.ts'
import {
  SMS_PRICE_PROVIDERS,
  SMS_SEGMENT_PRICES,
  type SmsProviderPrices,
  segmentSms,
  smsCampaignCost,
  smsCost,
  smsSegmentPrice,
} from './segments.ts'

/**
 * C-AUTO-02's money acceptance line: "Cost is integer fils per segment from a provider price table;
 * total == segments * unitPrice exactly, and constructing a price from a float is a type error (reuses
 * the F05 money type)."
 *
 * The type half is stated twice, because the two spellings fail differently. `IntegerLiteral<12.5>`
 * resolving to `never` is the mechanism; a `@ts-expect-error` on the call somebody would actually write
 * is the claim. Both are checked by `tsc` and by nothing else at runtime, which is why gate 86 exists to
 * watch a fixture with a fractional rate in it fail the typechecker (ADR 0003).
 */

/** `true` exactly when `T` is uninhabited, which is what a refused literal resolves to. */
type IsNever<T> = [T] extends [never] ? true : false

// The fence itself: a fractional literal has no inhabitant, so no price can be built from one. Checked
// by the compiler; read below so a tidy-up cannot delete it as dead code.
const FRACTION_IS_REFUSED = true satisfies IsNever<IntegerLiteral<12.5>>
const INTEGER_IS_ACCEPTED = false satisfies IsNever<IntegerLiteral<12>>

describe('the price table', () => {
  it('has a row for every provider it declares and no others', () => {
    expect(Object.keys(SMS_SEGMENT_PRICES).sort()).toEqual([...SMS_PRICE_PROVIDERS].sort())
  })

  it('prices every encoding, in integer fils, in AED', () => {
    for (const provider of SMS_PRICE_PROVIDERS) {
      for (const encoding of SMS_ENCODINGS) {
        const price = smsSegmentPrice(provider, encoding)
        expect(price.currency, `${provider}/${encoding}`).toBe('AED')
        // Integer fils, never a float (ADR 0007). A fractional rate here would put a fraction of a fils
        // on every cost report derived from it.
        expect(Number.isInteger(price.fils), `${provider}/${encoding}`).toBe(true)
        expect(price.fils, `${provider}/${encoding}`).toBeGreaterThan(0)
      }
    }
  })

  it('charges more for a UCS-2 segment than a GSM-7 one, so the lookup is load-bearing', () => {
    // The control on the table's shape. With one rate for both encodings, a calculator that looked the
    // encoding up and then ignored it would produce identical totals and every assertion in this file
    // would pass (brief rule 3).
    expect(smsSegmentPrice('smsala', 'UCS-2').fils).toBeGreaterThan(
      smsSegmentPrice('smsala', 'GSM-7').fils,
    )
    expect(smsSegmentPrice('smsala', 'GSM-7').fils).toBe(12)
    expect(smsSegmentPrice('smsala', 'UCS-2').fils).toBe(30)
  })

  it('carries the open question that replaces it, rather than a comment saying provisional', () => {
    // brief rule 15: a plausible number that nothing marks as unconfirmed is indistinguishable from a
    // configured one. The marker is a field so that a screen showing a total can qualify it.
    for (const provider of SMS_PRICE_PROVIDERS) {
      expect(SMS_SEGMENT_PRICES[provider].provisionalUntil).toBe('Y6-sms-rate')
      expect(SMS_SEGMENT_PRICES[provider].why.length).toBeGreaterThan(40)
    }
    expect(smsCost('smsala', 'Booking confirmed.').provisionalUntil).toBe('Y6-sms-rate')
  })
})

describe('total is segments times the unit price, exactly', () => {
  it('multiplies the rate for the encoding the body is actually in', () => {
    for (const body of [
      '',
      'Booking confirmed.',
      'a'.repeat(161),
      'a'.repeat(1000),
      'ت'.repeat(150),
      '\u{1f600}'.repeat(67),
    ]) {
      const cost = smsCost('smsala', body)
      const segmentation = segmentSms(body)
      expect(cost.segmentation).toEqual(segmentation)
      expect(cost.unitPrice).toEqual(smsSegmentPrice('smsala', segmentation.encoding))
      // The acceptance line, verbatim: total == segments * unitPrice. Integer fils on both sides, so
      // there is nothing to round and no tolerance to allow.
      expect(cost.total.fils, `${body.length} chars`).toBe(
        segmentation.segments * cost.unitPrice.fils,
      )
      expect(cost.total.currency).toBe('AED')
    }
  })

  it('costs nothing for an empty body', () => {
    // Zero segments, so zero fils: a minimum charge on a body nobody wrote would show up as a cost for
    // a campaign that was never sent.
    expect(smsCost('smsala', '').total.fils).toBe(0)
    expect(smsCost('smsala', '').segmentation.segments).toBe(0)
  })

  it('prices the docs/04 section 5 worked example at three UCS-2 segments', () => {
    const arabic = smsCost('smsala', 'ت'.repeat(150))
    expect(arabic.segmentation.encoding).toBe('UCS-2')
    expect(arabic.segmentation.segments).toBe(3)
    expect(arabic.total.fils).toBe(90)
    // The comparison that has to be visible at authoring time: the same 150 characters in English are
    // one GSM-7 segment, so the Arabic body is seven and a half times the price rather than three.
    const english = smsCost('smsala', 'a'.repeat(150))
    expect(english.segmentation.segments).toBe(1)
    expect(english.total.fils).toBe(12)
    expect(arabic.total.fils / english.total.fils).toBe(7.5)
  })

  it('multiplies a campaign out without rounding', () => {
    // The number the manifest's summary is about: "before they send it to 2,000 people".
    expect(smsCampaignCost('smsala', 'ت'.repeat(150), 2000).fils).toBe(90 * 2000)
    expect(smsCampaignCost('smsala', 'a'.repeat(150), 2000).fils).toBe(12 * 2000)
    // A fractional recipient count is a runtime refusal from `multiply`, because it cannot be a type
    // error: the count arrives from a query.
    expect(() => smsCampaignCost('smsala', 'a', 1.5)).toThrow(/integer/)
  })

  it('charges the extra segment a cluster-safe split needs', () => {
    // 67 emoji are two segments by unit arithmetic and three once the surrogate pairs are kept whole.
    // The price follows the parts that will be sent, not the arithmetic, because that is what the vendor
    // will be handed.
    const cost = smsCost('smsala', '\u{1f600}'.repeat(67))
    expect(cost.segmentation.unitSegments).toBe(2)
    expect(cost.segmentation.segments).toBe(3)
    expect(cost.total.fils).toBe(90)
    // The control: it is 30 fils more than the arithmetic would have charged, and the field that says so
    // is set, so a reader can see why the two differ.
    expect(cost.segmentation.clusterCostsAnExtraSegment).toBe(true)
    expect(cost.total.fils - cost.segmentation.unitSegments * cost.unitPrice.fils).toBe(30)
  })
})

describe('a price cannot be built from a float', () => {
  it('refuses a fractional rate at compile time and accepts a whole one', () => {
    expect(FRACTION_IS_REFUSED).toBe(true)
    expect(INTEGER_IS_ACCEPTED).toBe(false)

    // The spelling somebody actually writes when a rate card says "AED 0.125 per segment". Inside a
    // `toThrow`, because the type error is the claim and the call still RUNS: `@ts-expect-error`
    // suppresses the compiler and not the runtime, so a bare statement here would fail this test with
    // F05's own refusal and prove the weaker half.
    expect(() =>
      // @ts-expect-error — 12.5 is not an integer number of fils, so `IntegerLiteral<12.5>` is `never`.
      money(fils(12.5)),
    ).toThrow(/must be an integer number of fils/)

    // And a bare number is not a price either: the table holds `Money`, so a rate cannot be swapped with
    // a segment count by accident.
    const bare = {
      perSegment: {
        // @ts-expect-error — 12 fils is not a Money; `money(fils(12))` is.
        'GSM-7': 12,
        'UCS-2': money(fils(30)),
      },
      provisionalUntil: 'Y6-sms-rate',
      why: 'a bare number where a Money belongs',
    } satisfies SmsProviderPrices

    // Read, so nothing above is removed as dead code by a future tidy-up.
    expect(Object.keys(bare.perSegment).sort()).toEqual(['GSM-7', 'UCS-2'])
  })

  it('still accepts the whole-fils construction the table uses, so the fence refuses only floats', () => {
    // The control. Two `@ts-expect-error`s and no positive case would be satisfied by a price type
    // nothing at all is assignable to, and the errors would be reported about a table nobody could
    // write.
    const legitimate: SmsProviderPrices = {
      perSegment: { 'GSM-7': money(fils(12)), 'UCS-2': money(fils(30)) },
      provisionalUntil: 'Y6-sms-rate',
      why: 'the same construction the shipped table uses, which must keep compiling',
    }
    expect(legitimate.perSegment['GSM-7'].fils).toBe(12)
    expect(legitimate.perSegment['UCS-2']).toEqual(SMS_SEGMENT_PRICES.smsala.perSegment['UCS-2'])
  })
})

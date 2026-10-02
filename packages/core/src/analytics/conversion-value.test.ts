import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  CONVERSION_VALUE_CURRENCY,
  conversionValueFromFils,
  conversionValueNumber,
  filsFromConversionValue,
} from './conversion-value.ts'

/**
 * The conversion value an ad platform is told (A-MEAS-03's adapters; A-MEAS-05's own acceptance line).
 *
 * The claim is the ROUND TRIP, and it is a property rather than a table of examples: the failure this
 * module exists to prevent is a figure one fils out, which no hand-picked example finds reliably and
 * which is not an error anywhere — it is a conversion value the platform reports and the journal does not.
 */

/**
 * The range the catalogue actually uses, with headroom.
 *
 * docs/13 §4's prices are tens of thousands of fils; a settled document spans every appointment, add-on
 * and bundle on it. Ten million fils is a hundred thousand dirhams, which is well past any single
 * document this business issues, and the NEGATIVE half is covered because a credit note pushes a negative
 * value and a no-show pushes a compensating void (A-MEAS-05).
 */
const CATALOGUE_FILS = fc.integer({ min: -10_000_000, max: 10_000_000 })

describe('the round trip', () => {
  it('is exact for every integer fils in the range the catalogue uses', () => {
    fc.assert(
      fc.property(CATALOGUE_FILS, (amount) => {
        expect(filsFromConversionValue(conversionValueFromFils(amount))).toBe(amount)
      }),
      { numRuns: 2_000 },
    )
  })

  it('produces exactly two decimal places, always', () => {
    fc.assert(
      fc.property(CATALOGUE_FILS, (amount) => {
        expect(conversionValueFromFils(amount)).toMatch(/^-?\d+\.\d{2}$/)
      }),
      { numRuns: 500 },
    )
  })

  it('keeps the sign, which a magnitude-only formatter would lose', () => {
    // The control that matters: an implementation that formatted `Math.abs` would pass the round trip for
    // every positive amount and turn a refund into a second sale.
    expect(conversionValueFromFils(-1)).toBe('-0.01')
    expect(conversionValueFromFils(-32_010)).toBe('-320.10')
    expect(filsFromConversionValue('-0.01')).toBe(-1)
  })
})

describe('the figures themselves', () => {
  it('converts the fils a price is quoted in to the decimal a platform takes', () => {
    expect(conversionValueFromFils(0)).toBe('0.00')
    expect(conversionValueFromFils(1)).toBe('0.01')
    expect(conversionValueFromFils(32_010)).toBe('320.10')
    expect(conversionValueNumber(32_010)).toBe(320.1)
  })

  it('is not a float division, which is what the exactness rests on', () => {
    // The pair that shows the difference: `0.07 * 100` is 7.000000000000001 in binary floating point, so
    // a multiply-back implementation rounds. This one parses two integers.
    expect(filsFromConversionValue('0.07')).toBe(7)
    expect(filsFromConversionValue('8.29')).toBe(829)
    expect(filsFromConversionValue('1.10')).toBe(110)
  })

  it('accepts one decimal place and reads it as tenths, not hundredths', () => {
    // `320.1` is 32,010 fils. Padding on the right rather than the left is the whole of it, and reading
    // it as 3,201 would understate every figure that came back from a platform by a factor of ten.
    expect(filsFromConversionValue('320.1')).toBe(32_010)
    expect(filsFromConversionValue('320')).toBe(32_000)
  })
})

describe('the refusals', () => {
  it('refuses a fractional fils rather than rounding it', () => {
    // A fractional fils here is a figure that came from a float somewhere upstream, and pushing it would
    // report a value the journal cannot produce.
    expect(() => conversionValueFromFils(320.5)).toThrow(/not a whole number/)
  })

  it('refuses a third decimal place rather than deciding which way a half-fils goes', () => {
    expect(() => filsFromConversionValue('320.105')).toThrow(/Two decimal places at most/)
    expect(() => filsFromConversionValue('not a number')).toThrow(/Two decimal places at most/)
    expect(() => filsFromConversionValue('')).toThrow(/Two decimal places at most/)
  })
})

describe('the currency', () => {
  it('is AED and is one statement', () => {
    expect(CONVERSION_VALUE_CURRENCY).toBe('AED')
  })
})

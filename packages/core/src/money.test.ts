import { AppError } from '@berelax/shared'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  add,
  aed,
  aedFrom,
  compare,
  fils,
  filsFrom,
  formatAmount,
  formatMoney,
  grossFromNet,
  money,
  multiply,
  roundHalfUp,
  splitGross,
  subtract,
  sum,
  toDecimalString,
  UAE_STANDARD_VAT_BP,
  vatRateBp,
  ZERO_RATED_BP,
} from './money.ts'

describe('fils construction', () => {
  it('accepts an integer literal', () => {
    expect(fils(25_000)).toBe(25_000)
  })

  it('rejects a fractional value at runtime', () => {
    expect(() => filsFrom(1.5)).toThrow(AppError)
    expect(() => filsFrom(1.5)).toThrow(/integer number of fils/)
  })

  it('rejects NaN and Infinity, which are how float bugs actually arrive', () => {
    expect(() => filsFrom(Number.NaN)).toThrow(/finite/)
    expect(() => filsFrom(Number.POSITIVE_INFINITY)).toThrow(/finite/)
  })

  it('rejects a value beyond the safe integer range', () => {
    expect(() => filsFrom(Number.MAX_SAFE_INTEGER + 2)).toThrow()
  })

  // A fractional LITERAL is a compile-time error, which cannot be asserted at runtime:
  //   fils(1.5)  ->  Argument of type 'number' is not assignable to parameter of type 'never'
  // Proven by the typecheck gate, not by this suite.
})

describe('arithmetic', () => {
  it('adds and subtracts in fils', () => {
    expect(add(aed(200), aed(50)).fils).toBe(25_000)
    expect(subtract(aed(200), aed(50)).fils).toBe(15_000)
  })

  it('refuses to mix currencies', () => {
    const gbp = { fils: fils(100), currency: 'GBP' as unknown as 'AED' }
    expect(() => add(aed(1), gbp)).toThrow(/Cannot combine/)
  })

  it('multiplies only by an integer quantity', () => {
    expect(multiply(aed(200), 3).fils).toBe(60_000)
    expect(() => multiply(aed(200), 1.5)).toThrow(/integer/)
  })

  it('sums an empty list to zero rather than throwing', () => {
    expect(sum([]).fils).toBe(0)
  })

  it('compares without floating point', () => {
    expect(compare(aed(200), aed(300))).toBe(-1)
    expect(compare(aed(300), aed(300))).toBe(0)
    expect(compare(aed(400), aed(300))).toBe(1)
  })
})

describe('roundHalfUp', () => {
  it('rounds .5 away from zero in both directions', () => {
    expect(roundHalfUp(2.5)).toBe(3)
    expect(roundHalfUp(-2.5)).toBe(-3) // Math.round(-2.5) is -2, which is wrong for a refund
    expect(roundHalfUp(2.4)).toBe(2)
    expect(roundHalfUp(-2.4)).toBe(-2)
  })
})

describe('splitGross — the real catalogue prices', () => {
  // From docs/13-business-profile.md §4. These are the numbers that will appear on invoices.
  const cases: ReadonlyArray<readonly [number, string, string]> = [
    [170, '161.90', '8.10'],
    [200, '190.48', '9.52'],
    [250, '238.10', '11.90'],
    [300, '285.71', '14.29'],
    [350, '333.33', '16.67'],
    [400, '380.95', '19.05'],
    [440, '419.05', '20.95'],
    [450, '428.57', '21.43'],
    [500, '476.19', '23.81'],
    [520, '495.24', '24.76'],
    [550, '523.81', '26.19'],
    [620, '590.48', '29.52'],
  ]

  for (const [gross, expectedNet, expectedVat] of cases) {
    it(`AED ${gross} gross splits to ${expectedNet} net + ${expectedVat} VAT`, () => {
      // aedFrom, not aed: `gross` is a variable, and the literal-only constructor rejects it at
      // compile time. That refusal is the feature — it is what stops `aed(price * 1.05)`.
      const b = splitGross(aedFrom(gross))
      expect(toDecimalString(b.net)).toBe(expectedNet)
      expect(toDecimalString(b.vat)).toBe(expectedVat)
      expect(add(b.net, b.vat).fils).toBe(b.gross.fils)
    })
  }
})

describe('splitGross — properties', () => {
  const grossArb = fc.integer({ min: 0, max: 100_000_000 }) // up to AED 1,000,000

  it('net + vat === gross, exactly, for every gross amount', () => {
    fc.assert(
      fc.property(grossArb, (f) => {
        const b = splitGross(money(filsFrom(f)))
        return b.net.fils + b.vat.fils === f
      }),
      { numRuns: 5000 },
    )
  })

  it('VAT is never negative and never exceeds the gross', () => {
    fc.assert(
      fc.property(grossArb, (f) => {
        const b = splitGross(money(filsFrom(f)))
        return b.vat.fils >= 0 && b.vat.fils <= f
      }),
      { numRuns: 2000 },
    )
  })

  it('net is within one fils of the exact mathematical value', () => {
    fc.assert(
      fc.property(grossArb, (f) => {
        const b = splitGross(money(filsFrom(f)))
        return Math.abs(b.net.fils - (f * 10_000) / 10_500) <= 1
      }),
      { numRuns: 2000 },
    )
  })

  it('is monotonic: a larger gross never yields a smaller net', () => {
    fc.assert(
      fc.property(grossArb, grossArb, (a, b) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a]
        return splitGross(money(filsFrom(lo))).net.fils <= splitGross(money(filsFrom(hi))).net.fils
      }),
      { numRuns: 2000 },
    )
  })

  it('splitting a sum of line totals equals the gross of the invoice', () => {
    // Guards against the classic invoice discrepancy: rounding per line, then summing, must still
    // reconcile to the document total.
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 5_000_000 }), { minLength: 1, maxLength: 20 }),
        (lines) => {
          const lineBreakdowns = lines.map((f) => splitGross(money(filsFrom(f))))
          const netTotal = lineBreakdowns.reduce((n, b) => n + b.net.fils, 0)
          const vatTotal = lineBreakdowns.reduce((n, b) => n + b.vat.fils, 0)
          const grossTotal = lines.reduce((n, f) => n + f, 0)
          return netTotal + vatTotal === grossTotal
        },
      ),
      { numRuns: 2000 },
    )
  })

  it('zero-rated supply produces no VAT', () => {
    fc.assert(
      fc.property(grossArb, (f) => {
        const b = splitGross(money(filsFrom(f)), ZERO_RATED_BP)
        return b.vat.fils === 0 && b.net.fils === f
      }),
      { numRuns: 500 },
    )
  })
})

describe('grossFromNet', () => {
  it('round-trips a supplier bill back to the same net', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 50_000_000 }), (netFils) => {
        const b = grossFromNet(money(filsFrom(netFils)))
        return b.net.fils + b.vat.fils === b.gross.fils
      }),
      { numRuns: 2000 },
    )
  })

  it('applies 5% to a round net amount', () => {
    const b = grossFromNet(aed(100))
    expect(toDecimalString(b.vat)).toBe('5.00')
    expect(toDecimalString(b.gross)).toBe('105.00')
  })
})

describe('vatRateBp', () => {
  it('accepts the UAE standard rate', () => {
    expect(vatRateBp(500)).toBe(UAE_STANDARD_VAT_BP)
  })

  it('rejects a rate outside 0–100%', () => {
    expect(() => vatRateBp(-1)).toThrow()
    expect(() => vatRateBp(10_001)).toThrow()
    expect(() => vatRateBp(5.5)).toThrow()
  })
})

describe('formatting', () => {
  it('formats AED with two decimals', () => {
    expect(formatMoney(aed(250))).toContain('250.00')
  })

  it('uses Latin numerals in Arabic, per docs/08 §7', () => {
    const formatted = formatMoney(aed(250), 'ar')
    expect(formatted).toMatch(/250/)
    expect(formatted).not.toMatch(/[٠-٩]/)
  })

  it('renders a negative amount with a leading minus', () => {
    expect(toDecimalString(subtract(aed(0), aed(12)))).toBe('-12.00')
  })

  it('formats a bare figure for a column whose header states the currency', () => {
    // Grouped, two decimals, and no currency at all: a tax invoice carries six numeric columns across
    // A4 and AED in every cell of every one of them does not fit, so the code goes in the column head.
    expect(formatAmount(aed(1234))).toBe('1,234.00')
    expect(formatAmount(money(filsFrom(11)))).toBe('0.11')
    expect(formatAmount(aed(1234))).not.toContain('AED')
    // The pair, and the reason both exist: formatMoney is what states the currency, so no amount is
    // ever bare by accident.
    expect(formatMoney(aed(1234))).toContain('AED')
    expect(formatMoney(aed(1234))).toContain('1,234.00')
  })
})

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  assertStatementIsInThePast,
  CONVERSION_STATEMENT_REASONS,
  CONVERSION_VALUE_CURRENCY,
  type ConversionStatement,
  conversionLedgerNetFils,
  conversionStatements,
  conversionValueFromFils,
  conversionValueNumber,
  filsFromConversionValue,
  packageConversionStatements,
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

/* ------------------------------------------------------------------------------------------------
 * The conversion ledger (A-MEAS-05)
 * ------------------------------------------------------------------------------------------------ */

const VISIT = '2026-09-30T14:30:00.000Z'
const NO_SHOW_AT = '2026-09-30T16:00:00.000Z'
const CREDITED_AT = '2026-10-21T10:15:00.000Z'
const PASS_AT = '2026-10-23T02:05:00.000Z'

/** Every revision is its own, consecutive from zero, which is what makes each statement's id its own. */
const revisionsOf = (statements: readonly ConversionStatement[]) =>
  statements.map((statement) => statement.revision)

describe('a booking that became a no-show', () => {
  it('sums to EXACTLY zero fils, which is the acceptance line', () => {
    const statements = conversionStatements({
      initialFils: 32_010,
      occurredAtIso: VISIT,
      noShow: { atIso: NO_SHOW_AT },
    })
    expect(conversionLedgerNetFils(statements)).toBe(0)
    // And the void is a SECOND statement rather than an edit of the first, which is what ZY451 refuses
    // and what stops the platform discarding the correction as a duplicate.
    expect(statements).toHaveLength(2)
    expect(revisionsOf(statements)).toEqual([0, 1])
    expect(statements[0]?.valueFils).toBe(32_010)
    expect(statements[1]?.reason).toBe('no_show_void')
    expect(statements[1]?.valueFils).toBe(-32_010)
  })

  it('voids everything already stated, over three statements rather than two', () => {
    /*
     * A no-show after a corrected invoice has had TWO figures pushed, and the void has to answer for
     * both. It is written as the negative of the running SUM rather than of `initialFils`, and this case
     * is where that is asserted — including the honest note that today the two coincide: the correction's
     * whole job is to bring the net to `initialFils`, so `-net` and `-initialFils` are the same number
     * for every input this function currently accepts. `-net` is written anyway because it is a property
     * of the ledger rather than of the one reason that happens to converge, and a fifth reason that did
     * not converge would otherwise leave a conversion standing at the difference.
     */
    const statements = conversionStatements({
      initialFils: 28_000,
      alreadyPushedFils: 32_010,
      occurredAtIso: VISIT,
      noShow: { atIso: NO_SHOW_AT },
    })
    expect(conversionLedgerNetFils(statements)).toBe(0)
    expect(statements.map((statement) => statement.reason)).toEqual([
      'initial',
      'invoice_correction',
      'no_show_void',
    ])
    expect(statements[2]?.valueFils).toBe(-conversionLedgerNetFils(statements.slice(0, 2)))
    expect(revisionsOf(statements)).toEqual([0, 1, 2])
  })

  it('dates the void on the no-show and not on the visit', () => {
    const statements = conversionStatements({
      initialFils: 10_000,
      occurredAtIso: VISIT,
      noShow: { atIso: NO_SHOW_AT },
    })
    expect(statements[0]?.occurredAtIso).toBe(VISIT)
    expect(statements[1]?.occurredAtIso).toBe(NO_SHOW_AT)
  })
})

describe('a credit note or a partial refund', () => {
  it('pushes a negative value equal to the credit, to the fils', () => {
    const statements = conversionStatements({
      initialFils: 32_010,
      occurredAtIso: VISIT,
      credited: { grossFils: 12_505, atIso: CREDITED_AT },
    })
    expect(statements[1]?.reason).toBe('credit_note')
    expect(statements[1]?.valueFils).toBe(-12_505)
    // A PARTIAL refund leaves the difference standing, which is the figure the journal holds.
    expect(conversionLedgerNetFils(statements)).toBe(19_505)
    // Dated on the credit note and not on the treatment: a platform dates every statement on its own
    // value, and a credit raised three weeks later belongs in that week's window.
    expect(statements[1]?.occurredAtIso).toBe(CREDITED_AT)
  })

  it('sums to zero for a FULL credit, without a special case for it', () => {
    const statements = conversionStatements({
      initialFils: 32_010,
      occurredAtIso: VISIT,
      credited: { grossFils: 32_010, atIso: CREDITED_AT },
    })
    expect(conversionLedgerNetFils(statements)).toBe(0)
  })

  it('refuses a negative credit rather than pushing a positive value for it', () => {
    // A negative credit would push a POSITIVE value and report a refund as a second sale. The sign is
    // this function's to apply, which is why the input is the gross.
    expect(() =>
      conversionStatements({
        initialFils: 32_010,
        occurredAtIso: VISIT,
        credited: { grossFils: -12_505, atIso: CREDITED_AT },
      }),
    ).toThrow(/whole non-negative amount/)
  })
})

describe('a discounted invoice', () => {
  it('reaches the invoice gross and not the booking estimate', () => {
    // The acceptance line, as arithmetic: whatever was pushed, the SUM is the gross the document says.
    const statements = conversionStatements({
      initialFils: 25_000,
      alreadyPushedFils: 32_010,
      occurredAtIso: VISIT,
    })
    expect(conversionLedgerNetFils(statements)).toBe(25_000)
    expect(statements[1]?.reason).toBe('invoice_correction')
    expect(statements[1]?.valueFils).toBe(-7_010)
  })

  it('states one statement when the gross is what was already pushed', () => {
    // The control: a correction with nothing to correct would be a second conversion for one treatment.
    const statements = conversionStatements({
      initialFils: 32_010,
      alreadyPushedFils: 32_010,
      occurredAtIso: VISIT,
    })
    expect(statements).toHaveLength(1)
    expect(conversionLedgerNetFils(statements)).toBe(32_010)
  })
})

describe('a package, on the Y11-vat-package provisional position', () => {
  it('pushes zero at the sale and the released value at redemption', () => {
    const statements = packageConversionStatements({
      saleAtIso: VISIT,
      redemption: { releasedFils: 16_000, redeemedAtIso: CREDITED_AT },
    })
    expect(statements[0]?.valueFils).toBe(0)
    expect(statements[0]?.occurredAtIso).toBe(VISIT)
    expect(statements[1]?.reason).toBe('package_redemption')
    expect(statements[1]?.valueFils).toBe(16_000)
    expect(conversionLedgerNetFils(statements)).toBe(16_000)
  })

  it('states the sale as a ZERO conversion rather than as no conversion at all', () => {
    // The distinction A-MEAS-07's classification rests on: a sale with no dispatch is indistinguishable
    // from a sale the pass never saw.
    const statements = packageConversionStatements({ saleAtIso: VISIT })
    expect(statements).toHaveLength(1)
    expect(statements[0]?.valueFils).toBe(0)
    expect(conversionLedgerNetFils(statements)).toBe(0)
  })

  it('refuses a negative released figure', () => {
    expect(() =>
      packageConversionStatements({
        saleAtIso: VISIT,
        redemption: { releasedFils: -1, redeemedAtIso: CREDITED_AT },
      }),
    ).toThrow(/whole non-negative/)
  })
})

describe('the ledger arithmetic itself', () => {
  it('is exact over the fils range the catalogue uses, with no float anywhere', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -10_000_000, max: 10_000_000 }), {
          minLength: 1,
          maxLength: 12,
        }),
        (amounts) => {
          const statements = amounts.map((valueFils, index) => ({
            revision: index,
            reason: 'initial' as const,
            valueFils,
            occurredAtIso: VISIT,
          }))
          expect(conversionLedgerNetFils(statements)).toBe(
            amounts.reduce((total, amount) => total + amount, 0),
          )
        },
      ),
      { numRuns: 500 },
    )
  })

  it('refuses a fractional fils in the sum rather than carrying it', () => {
    expect(() =>
      conversionLedgerNetFils([
        { revision: 0, reason: 'initial', valueFils: 320.5, occurredAtIso: VISIT },
      ]),
    ).toThrow(/not a whole number/)
  })

  it('refuses a fractional initial figure, which is a float arriving from upstream', () => {
    expect(() => conversionStatements({ initialFils: 1.5, occurredAtIso: VISIT })).toThrow(
      /not a whole number/,
    )
  })

  it('uses every declared reason, so none is dead', () => {
    const used = new Set<string>([
      ...conversionStatements({
        initialFils: 28_000,
        alreadyPushedFils: 32_010,
        occurredAtIso: VISIT,
        noShow: { atIso: NO_SHOW_AT },
      }).map((statement) => statement.reason),
      ...conversionStatements({
        initialFils: 32_010,
        occurredAtIso: VISIT,
        credited: { grossFils: 1, atIso: CREDITED_AT },
      }).map((statement) => statement.reason),
      ...packageConversionStatements({
        saleAtIso: VISIT,
        redemption: { releasedFils: 1, redeemedAtIso: CREDITED_AT },
      }).map((statement) => statement.reason),
    ])
    expect([...used].sort()).toEqual([...CONVERSION_STATEMENT_REASONS].sort())
  })
})

describe('the past-event instant', () => {
  it('accepts the real visit instant, which is days before the pass', () => {
    const [statement] = conversionStatements({ initialFils: 32_010, occurredAtIso: VISIT })
    expect(statement).toBeDefined()
    expect(() =>
      assertStatementIsInThePast({
        statement: statement as ConversionStatement,
        passAtIso: PASS_AT,
      }),
    ).not.toThrow()
  })

  it('refuses an instant equal to the pass, which is what a clock read here produces', () => {
    // The database's own `occurred_at <= decided_at` is satisfied by EQUALITY, so it cannot tell "the
    // visit was two days ago" from "the visit was this instant". This is the check that can.
    expect(() =>
      assertStatementIsInThePast({
        statement: { revision: 0, reason: 'initial', valueFils: 1, occurredAtIso: PASS_AT },
        passAtIso: PASS_AT,
      }),
    ).toThrow(/not before the pass/)
  })

  it('refuses a FUTURE instant, which is the one value Meta rejects outright', () => {
    expect(() =>
      assertStatementIsInThePast({
        statement: {
          revision: 0,
          reason: 'initial',
          valueFils: 1,
          occurredAtIso: '2026-12-01T00:00:00.000Z',
        },
        passAtIso: PASS_AT,
      }),
    ).toThrow(/not before the pass/)
  })

  it('refuses an unparseable instant rather than judging it', () => {
    expect(() =>
      assertStatementIsInThePast({
        statement: { revision: 0, reason: 'initial', valueFils: 1, occurredAtIso: 'yesterday' },
        passAtIso: PASS_AT,
      }),
    ).toThrow(/not an instant/)
  })
})

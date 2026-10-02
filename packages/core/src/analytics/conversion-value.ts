/**
 * The conversion value an ad platform is told, in the one unit both platforms accept.
 *
 * ## Why this is in `packages/core` and not beside the adapters
 *
 * Money arithmetic is `packages/core`'s and this is money arithmetic: integer fils in, a figure in the
 * currency's major unit out. Putting it beside the GA4 and Meta adapters would be two conversions — one
 * per adapter — and two conversions is how two platforms come to be told two different figures for one
 * conversion. That variance is exactly what A-MEAS-07 reports and exactly what nobody could attribute,
 * because both sides would look internally consistent.
 *
 * ## The round trip is the claim, not the formatting
 *
 * Both platforms take `value` as a decimal in the major unit, and this build stores integer fils,
 * VAT-inclusive gross authoritative (ADR 0007). The dangerous half is not the division: it is that
 * `fils / 100` is a binary float, so `32010 / 100` is `320.1` and `fils * 100` on the way back can land a
 * fils either side. A figure that is one fils out is not an error anywhere — it is a conversion value the
 * platform reports and the journal does not, and the difference shows up as an unattributable variance in
 * a reconciliation months later.
 *
 * So the conversion goes through `toDecimalString`, which is integer arithmetic (`floor(abs / 100)` and
 * `abs % 100`) and cannot be a fils out, and {@link filsFromConversionValue} parses the two parts back as
 * integers rather than multiplying a float. The round trip is then exact by construction over every
 * integer, and `conversion-value.test.ts` asserts it as a property across the whole range the catalogue
 * uses rather than over a handful of examples.
 *
 * ## Negative values are first-class
 *
 * A credit note pushes a negative value equal to the credit, and a no-show pushes a compensating void
 * (A-MEAS-05), so the sign is part of the figure and not an error to be clamped. `toDecimalString` already
 * handles it, and the property test covers the negative range for the reason the positive one is covered:
 * `-1` fils is `-0.01`, and an implementation that formatted the magnitude and lost the sign would turn a
 * refund into a second sale.
 */

import { AppError } from '@berelax/shared'
import { type Fils, filsFrom, money, toDecimalString } from '../money.ts'

/** The currency every figure here is in. AED is the legal entity's, not a payload's (ADR 0007). */
export const CONVERSION_VALUE_CURRENCY = 'AED'

/**
 * The exact two-decimal representation of an integer fils amount.
 *
 * A STRING, deliberately, and the `number` form is {@link conversionValueNumber} one function down. The
 * string is what the round trip is stated over, because a string has no representation question — and a
 * caller that wants the number gets it from a function whose name says a float is being produced.
 */
export function conversionValueFromFils(fils: number): string {
  if (!Number.isInteger(fils)) {
    throw new AppError(
      'validation',
      `A conversion value was asked for from ${fils} fils, which is not a whole number. Money is ` +
        'integer fils in this build (ADR 0007), and a fractional fils here is a figure that came from a ' +
        'float somewhere upstream — pushing it would report a value the journal cannot produce.',
      { details: { fils } },
    )
  }
  return toDecimalString(money(filsFrom(fils)))
}

/**
 * The number form, for a JSON body.
 *
 * `Number(...)` of the exact string rather than `fils / 100`, which is the same value for every amount
 * this catalogue reaches and is NOT the same statement: the string is the authority, and parsing it is
 * what keeps the body and the stored figure derived from one expression. `fils / 100` beside
 * {@link conversionValueFromFils} would be the second statement of one fact, which drifts.
 */
export function conversionValueNumber(fils: number): number {
  return Number(conversionValueFromFils(fils))
}

/**
 * Integer fils from a two-decimal figure, exactly.
 *
 * Parses the two parts as integers rather than multiplying a float, so there is no rounding step to get
 * wrong. A figure with more than two decimal places is REFUSED rather than rounded: this build cannot
 * represent it, and rounding it here would silently decide which way a half-fils goes in a value somebody
 * reconciles against a tax invoice.
 */
export function filsFromConversionValue(value: string): Fils {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim())
  if (match === null) {
    throw new AppError(
      'validation',
      `${JSON.stringify(value)} is not a conversion value this build can represent. Two decimal places ` +
        'at most, because money is integer fils (ADR 0007) — and rounding a third place here would ' +
        'silently decide which way a half-fils goes in a figure somebody reconciles against an invoice.',
      { details: { value } },
    )
  }
  const [, sign = '', major = '0', minorRaw = ''] = match
  const minor = minorRaw.padEnd(2, '0')
  const magnitude = Number.parseInt(major, 10) * 100 + Number.parseInt(minor, 10)
  return filsFrom(sign === '-' ? -magnitude : magnitude)
}

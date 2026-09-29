import { AppError } from '@berelax/shared'
import type { Currency, Money } from '../money.ts'
import { filsFrom } from '../money.ts'

/**
 * The one place a gateway's minor-unit convention is converted, and the refusal when it cannot be.
 *
 * ADR 0007 fixes our representation: integer fils, VAT-inclusive gross authoritative. A gateway that
 * reports minor units in another convention — thousandths, or whole dirhams — converts **at its edge and
 * nowhere else**, which means here, called from the adapter, and never in a consumer that happened to
 * notice the units were different.
 *
 * ## Why a refusal rather than a rounding
 *
 * The obvious alternative is to round. It is wrong in a way that does not show up for months: a gateway
 * reporting whole dirhams cannot express AED 262.50, so rounding a 26,250-fils capture down to 26,200
 * loses 50 fils on every transaction and the loss appears only when somebody reconciles a settlement
 * batch — by which time the figures are historical and the ledger has half a year of one-fils and
 * fifty-fils differences with no single cause to point at. A conversion that cannot be made exactly is
 * a statement that this gateway cannot carry this amount, and the honest time to say so is before the
 * money moves.
 *
 * ## The exponent, and the direction it runs
 *
 * `exponent` is how many decimal places the convention keeps: fils are hundredths of a dirham, so 2.
 * A gateway on 3 wants ten times our number; one on 0 wants a hundredth of it. There is no fractional
 * exponent and no rate: this is a change of units, not a currency conversion, and the day a second
 * currency arrives it will need a rate, a date and an ADR of its own rather than an extra argument here.
 */

/** A gateway's minor-unit convention. `label` is for the message a refusal shows. */
export interface MinorUnitConvention {
  readonly label: string
  /** Decimal places the convention keeps. Fils are 2. */
  readonly exponent: number
}

/** Ours. The identity conversion, and the only convention any figure is stored in. */
export const FILS_CONVENTION: MinorUnitConvention = Object.freeze({
  label: 'fils (hundredths of an AED)',
  exponent: 2,
})

/** The widest exponent a conversion will attempt, so a nonsense convention refuses at declaration. */
const MAX_EXPONENT = 6

/** Raised when a conversion in either direction cannot be made without losing or inventing fils. */
export class MinorUnitConversionInexact extends AppError {
  constructor(args: {
    readonly value: number
    readonly from: string
    readonly to: string
    readonly direction: 'to_gateway' | 'from_gateway'
  }) {
    super(
      'invariant_violated',
      `MinorUnitConversionInexact: ${args.value} in ${args.from} has no exact value in ${args.to}. ` +
        'Rounding it here would lose fils on every transaction and surface months later as a ' +
        'settlement that will not reconcile, so the conversion refuses instead (ADR 0007).',
      { details: { ...args } },
    )
    this.name = 'MinorUnitConversionInexact'
  }
}

/** Raised when a convention itself is unusable, before any amount is put through it. */
export class MinorUnitConventionInvalid extends AppError {
  constructor(convention: MinorUnitConvention) {
    super(
      'validation',
      `MinorUnitConventionInvalid: "${convention.label}" declares exponent ${convention.exponent}. ` +
        `A convention keeps between 0 and ${MAX_EXPONENT} decimal places, as an integer — anything ` +
        'else is a rate, and a rate needs a date and an ADR rather than an argument here.',
      { details: { label: convention.label, exponent: convention.exponent } },
    )
    this.name = 'MinorUnitConventionInvalid'
  }
}

function scaleOf(convention: MinorUnitConvention): number {
  if (
    !Number.isInteger(convention.exponent) ||
    convention.exponent < 0 ||
    convention.exponent > MAX_EXPONENT
  ) {
    throw new MinorUnitConventionInvalid(convention)
  }
  // 10^(their places - ours). Positive means they want a bigger number than we hold.
  return 10 ** (convention.exponent - FILS_CONVENTION.exponent)
}

/**
 * Our fils as the gateway's minor units.
 *
 * Integer arithmetic in both directions rather than a multiply-and-round: `fils * scale` for a scale ≥ 1
 * is exact, and for a scale < 1 the division is checked with a remainder instead of compared against a
 * rounded value. `Math.round(x) === x` is the version of this test that passes for 0.9999999999999999.
 */
export function toGatewayMinor(amount: Money, convention: MinorUnitConvention): number {
  const scale = scaleOf(convention)
  if (scale >= 1) return amount.fils * scale
  const divisor = Math.round(1 / scale)
  if (amount.fils % divisor !== 0) {
    throw new MinorUnitConversionInexact({
      value: amount.fils,
      from: FILS_CONVENTION.label,
      to: convention.label,
      direction: 'to_gateway',
    })
  }
  return amount.fils / divisor
}

/**
 * The gateway's minor units as our fils.
 *
 * The direction that actually protects the ledger: a gateway reporting thousandths can hand us 26,255,
 * which is 2,625.5 fils and is not an amount this business can receive. It refuses rather than reporting
 * 2,625 and leaving half a fils in the difference column of a settlement batch.
 */
export function fromGatewayMinor(
  value: number,
  convention: MinorUnitConvention,
  currency: Currency = 'AED',
): Money {
  if (!Number.isInteger(value)) {
    throw new MinorUnitConversionInexact({
      value,
      from: convention.label,
      to: FILS_CONVENTION.label,
      direction: 'from_gateway',
    })
  }
  const scale = scaleOf(convention)
  if (scale <= 1) return { fils: filsFrom(value * Math.round(1 / scale)), currency }
  const divisor = Math.round(scale)
  if (value % divisor !== 0) {
    throw new MinorUnitConversionInexact({
      value,
      from: convention.label,
      to: FILS_CONVENTION.label,
      direction: 'from_gateway',
    })
  }
  return { fils: filsFrom(value / divisor), currency }
}

/**
 * Does `amount` survive a round trip through `convention`?
 *
 * The predicate the conformance suite asserts for every adapter and every probe amount. It is a
 * predicate rather than the round trip itself because an adapter that cannot carry an amount must be
 * found out by a suite that keeps going, not by one that throws in its own harness.
 */
export function survivesMinorUnitRoundTrip(
  amount: Money,
  convention: MinorUnitConvention,
): boolean {
  try {
    const back = fromGatewayMinor(toGatewayMinor(amount, convention), convention, amount.currency)
    return back.fils === amount.fils && back.currency === amount.currency
  } catch {
    return false
  }
}

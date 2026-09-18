import type { Brand } from '@berelax/shared'
import { AppError } from '@berelax/shared'

/**
 * Money, as integer minor units, VAT-inclusive.
 *
 * Two decisions from docs/01 are encoded here and neither is negotiable:
 *
 *   1. **Integer fils, never a float.** 1 AED = 100 fils. A float in a money column produces errors
 *      that are only discovered during a VAT reconciliation, by which point they are historical.
 *   2. **Gross is authoritative.** UAE consumer prices are displayed tax-inclusive and the advertised
 *      price must be honoured. Storing net produces prices like AED 262.50 that marketing rounds,
 *      silently desynchronising the price the client agreed, the invoice and the ledger.
 *
 * Net and VAT are therefore always *derived* from gross, and VAT is derived as the **remainder**
 * rather than rounded independently — which is what makes `net + vat === gross` exact for every
 * input rather than almost every input.
 */

export type Fils = Brand<number, 'Fils'>
export type Currency = 'AED'

export interface Money {
  readonly fils: Fils
  readonly currency: Currency
}

/**
 * Accepts an integer literal and rejects a fractional one **at compile time**:
 * `` `${1.5}` `` is `"1.5"`, which does not extend `` `${bigint}` ``.
 */
export type IntegerLiteral<N extends number> = `${N}` extends `${bigint}` ? N : never

const MAX_FILS = Number.MAX_SAFE_INTEGER

function assertInteger(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new AppError('validation', `${label} must be finite, received ${value}`)
  }
  if (!Number.isInteger(value)) {
    throw new AppError(
      'validation',
      `${label} must be an integer number of fils, received ${value}. Money is never fractional — ` +
        'if this came from a division, round it deliberately first.',
    )
  }
  if (Math.abs(value) > MAX_FILS) {
    throw new AppError('validation', `${label} exceeds the safe integer range: ${value}`)
  }
}

/** Construct fils from an integer literal. A fractional literal is a type error. */
export function fils<N extends number>(value: IntegerLiteral<N>): Fils {
  assertInteger(value as number, 'fils')
  return value as unknown as Fils
}

/** Construct fils from a computed value. Validated at runtime, since types cannot help here. */
export function filsFrom(value: number): Fils {
  assertInteger(value, 'fils')
  return value as Fils
}

/** Whole AED from an integer literal. `aed(1.5)` is a compile-time error; use `aedFrom` instead. */
export function aed<N extends number>(value: IntegerLiteral<N>): Money {
  return { fils: filsFrom((value as number) * 100), currency: 'AED' }
}

/**
 * Whole AED from a computed value, validated at runtime.
 *
 * The literal-only `aed` cannot accept a variable, which is deliberate — it is what makes a stray
 * `aed(price * 1.05)` fail to compile. Anything genuinely computed comes through here, where the
 * integer check is explicit rather than implied.
 */
export function aedFrom(value: number): Money {
  assertInteger(value, 'AED major units')
  return { fils: filsFrom(value * 100), currency: 'AED' }
}

export function money(amount: Fils, currency: Currency = 'AED'): Money {
  return { fils: amount, currency }
}

export const ZERO_AED: Money = { fils: 0 as Fils, currency: 'AED' }

function sameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new AppError('invariant_violated', `Cannot combine ${a.currency} with ${b.currency}`)
  }
}

export function add(a: Money, b: Money): Money {
  sameCurrency(a, b)
  return { fils: filsFrom(a.fils + b.fils), currency: a.currency }
}

export function subtract(a: Money, b: Money): Money {
  sameCurrency(a, b)
  return { fils: filsFrom(a.fils - b.fils), currency: a.currency }
}

export function multiply(a: Money, quantity: number): Money {
  if (!Number.isInteger(quantity)) {
    throw new AppError('validation', `Quantity must be an integer, received ${quantity}`)
  }
  return { fils: filsFrom(a.fils * quantity), currency: a.currency }
}

export function sum(amounts: readonly Money[], currency: Currency = 'AED'): Money {
  return amounts.reduce((acc, m) => add(acc, m), { fils: 0 as Fils, currency })
}

export function isZero(a: Money): boolean {
  return a.fils === 0
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  sameCurrency(a, b)
  return a.fils < b.fils ? -1 : a.fils > b.fils ? 1 : 0
}

/**
 * Half-up rounding away from zero, which is what a person expects when they see a price and what
 * UAE invoice practice follows. `Math.round` rounds −0.5 to −0, which differs for refunds.
 */
export function roundHalfUp(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value)
}

// --- VAT ---------------------------------------------------------------------------------------

/** A VAT rate in basis points. 500 bp = 5%, the UAE standard rate. */
export type VatRateBp = Brand<number, 'VatRateBp'>

export const UAE_STANDARD_VAT_BP = 500 as VatRateBp
export const ZERO_RATED_BP = 0 as VatRateBp

export function vatRateBp(basisPoints: number): VatRateBp {
  assertInteger(basisPoints, 'VAT basis points')
  if (basisPoints < 0 || basisPoints > 10_000) {
    throw new AppError('validation', `VAT rate out of range: ${basisPoints} bp`)
  }
  return basisPoints as VatRateBp
}

export interface VatBreakdown {
  /** What the customer pays. Authoritative. */
  readonly gross: Money
  /** Derived. */
  readonly net: Money
  /** Derived as `gross - net`, never rounded independently. */
  readonly vat: Money
  readonly rateBp: VatRateBp
}

/**
 * Splits a VAT-inclusive gross amount into net and VAT.
 *
 * `net = roundHalfUp(gross * 10000 / (10000 + rate))`, then `vat = gross - net`.
 *
 * Deriving VAT as the remainder is the whole trick: rounding both independently produces cases where
 * `net + vat !== gross`, and those cases appear on invoices as a one-fils discrepancy that has to be
 * explained to an auditor.
 */
export function splitGross(gross: Money, rateBp: VatRateBp = UAE_STANDARD_VAT_BP): VatBreakdown {
  const netFils = roundHalfUp((gross.fils * 10_000) / (10_000 + rateBp))
  const net: Money = { fils: filsFrom(netFils), currency: gross.currency }
  const vat: Money = { fils: filsFrom(gross.fils - netFils), currency: gross.currency }
  return { gross, net, vat, rateBp }
}

/** Builds a gross amount from a net amount. Used for supplier bills, which arrive net. */
export function grossFromNet(net: Money, rateBp: VatRateBp = UAE_STANDARD_VAT_BP): VatBreakdown {
  const vatFils = roundHalfUp((net.fils * rateBp) / 10_000)
  const gross: Money = { fils: filsFrom(net.fils + vatFils), currency: net.currency }
  return { gross, net, vat: { fils: filsFrom(vatFils), currency: net.currency }, rateBp }
}

// --- formatting --------------------------------------------------------------------------------

/**
 * Formats for display. Latin numerals are used even in Arabic, matching UAE commercial practice and
 * the `Intl.NumberFormat('ar-AE-u-nu-latn')` decision in docs/08 §7.
 */
export function formatMoney(amount: Money, locale: 'en' | 'ar' = 'en'): string {
  const intlLocale = locale === 'ar' ? 'ar-AE-u-nu-latn' : 'en-AE'
  return new Intl.NumberFormat(intlLocale, {
    style: 'currency',
    currency: amount.currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount.fils / 100)
}

/** Stable, locale-independent representation for logs, tests and ledger references. */
export function toDecimalString(amount: Money): string {
  const negative = amount.fils < 0
  const abs = Math.abs(amount.fils)
  const major = Math.floor(abs / 100)
  const minor = String(abs % 100).padStart(2, '0')
  return `${negative ? '-' : ''}${major}.${minor}`
}

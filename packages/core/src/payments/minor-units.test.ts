import { describe, expect, it } from 'vitest'
import { TENDER_KINDS } from '../checkout/posting.ts'
import { TENDER_TYPES } from '../money/tender.ts'
import { aed, filsFrom, money } from '../money.ts'
import {
  assertIntegerFilsAmount,
  assertReferencePresent,
  assertServesInstrument,
  GatewayAmountNotIntegerFils,
  GatewayDoesNotServeInstrument,
  GatewayReferenceMissing,
} from './guards.ts'
import {
  FILS_CONVENTION,
  fromGatewayMinor,
  MinorUnitConventionInvalid,
  MinorUnitConversionInexact,
  survivesMinorUnitRoundTrip,
  toGatewayMinor,
} from './minor-units.ts'

/**
 * The minor-unit edge (ADR 0007) and the port's argument refusals.
 *
 * Both are here rather than in `@berelax/payments` because both are pure and both are what every adapter,
 * including the real one, is required to call. The conformance suite's saboteur fixture is what proves the
 * refusals can fail; these are what prove they are right.
 */

const THOUSANDTHS = { label: 'thousandths', exponent: 3 } as const
const WHOLE_DIRHAMS = { label: 'whole dirhams', exponent: 0 } as const

describe('our own convention is the identity', () => {
  it('leaves fils alone in both directions', () => {
    expect(toGatewayMinor(aed(350), FILS_CONVENTION)).toBe(35_000)
    expect(fromGatewayMinor(35_000, FILS_CONVENTION).fils).toBe(35_000)
  })

  it('declares two decimal places, because a dirham is a hundred fils', () => {
    expect(FILS_CONVENTION.exponent).toBe(2)
  })
})

describe('a wider convention scales up exactly', () => {
  it('multiplies by ten for thousandths', () => {
    expect(toGatewayMinor(money(filsFrom(26_250)), THOUSANDTHS)).toBe(262_500)
    expect(fromGatewayMinor(262_500, THOUSANDTHS).fils).toBe(26_250)
  })

  it('refuses a gateway figure that is a fraction of a fils', () => {
    // The direction that protects the ledger: 262,505 thousandths is 2,625.05 fils, which is not an amount
    // this business can receive. Rounding it would leave a fraction in a settlement difference column.
    expect(() => fromGatewayMinor(262_505, THOUSANDTHS)).toThrow(MinorUnitConversionInexact)
    expect(() => fromGatewayMinor(262_505, THOUSANDTHS)).toThrow(/has no exact value in/)
  })

  it('refuses a non-integer gateway figure outright', () => {
    expect(() => fromGatewayMinor(262_500.5, THOUSANDTHS)).toThrow(MinorUnitConversionInexact)
  })
})

describe('a narrower convention refuses rather than rounding', () => {
  it('cannot carry AED 262.50 in whole dirhams', () => {
    // ADR 0007's own example. Rounding it down loses fifty fils per transaction, and the loss appears only
    // when somebody reconciles a settlement batch months later.
    expect(() => toGatewayMinor(money(filsFrom(26_250)), WHOLE_DIRHAMS)).toThrow(
      MinorUnitConversionInexact,
    )
  })

  it('carries a whole dirham figure, so the refusal is about the amount and not the convention', () => {
    expect(toGatewayMinor(aed(350), WHOLE_DIRHAMS)).toBe(350)
    expect(fromGatewayMinor(350, WHOLE_DIRHAMS).fils).toBe(35_000)
  })
})

describe('a convention that is not a change of units is refused at declaration', () => {
  it('refuses a fractional exponent, which would be a rate', () => {
    expect(() => toGatewayMinor(aed(1), { label: 'nonsense', exponent: 2.5 })).toThrow(
      MinorUnitConventionInvalid,
    )
  })

  it('refuses a negative exponent and an absurdly wide one', () => {
    expect(() => toGatewayMinor(aed(1), { label: 'nonsense', exponent: -1 })).toThrow(
      MinorUnitConventionInvalid,
    )
    expect(() => toGatewayMinor(aed(1), { label: 'nonsense', exponent: 12 })).toThrow(
      MinorUnitConventionInvalid,
    )
  })

  it('says a rate needs a date and an ADR rather than an argument here', () => {
    // The message is the decision: a second currency is a decision, not a parameter.
    expect(() => toGatewayMinor(aed(1), { label: 'nonsense', exponent: 2.5 })).toThrow(
      /a rate needs a date and an ADR/,
    )
  })
})

describe('the round-trip predicate the conformance suite uses', () => {
  it('accepts every probe amount under a convention that can carry it', () => {
    for (const value of [1, 5, 35_000, 26_250, 999_999]) {
      expect(survivesMinorUnitRoundTrip(money(filsFrom(value)), FILS_CONVENTION)).toBe(true)
      expect(survivesMinorUnitRoundTrip(money(filsFrom(value)), THOUSANDTHS)).toBe(true)
    }
  })

  it('rejects one fils under whole dirhams, which is the case that matters', () => {
    // The predicate rather than a throw, because an adapter that cannot carry an amount must be found out
    // by a suite that keeps going rather than by one that throws in its own harness.
    expect(survivesMinorUnitRoundTrip(money(filsFrom(1)), WHOLE_DIRHAMS)).toBe(false)
    expect(survivesMinorUnitRoundTrip(money(filsFrom(26_250)), WHOLE_DIRHAMS)).toBe(false)
  })

  it('the control: a whole-dirham amount does survive whole dirhams', () => {
    // Without this, the rejection above is satisfied by a predicate that answers false for everything.
    expect(survivesMinorUnitRoundTrip(aed(350), WHOLE_DIRHAMS)).toBe(true)
  })
})

describe('the port argument guards', () => {
  it('refuses a fractional amount, naming the field', () => {
    expect(() =>
      assertIntegerFilsAmount({ fils: 12.5 as never, currency: 'AED' }, 'the amount captured'),
    ).toThrow(GatewayAmountNotIntegerFils)
    expect(() =>
      assertIntegerFilsAmount({ fils: 12.5 as never, currency: 'AED' }, 'the amount captured'),
    ).toThrow(/the amount captured/)
  })

  it('keeps the underlying refusal as the cause, so nothing is lost', () => {
    try {
      assertIntegerFilsAmount({ fils: 12.5 as never, currency: 'AED' }, 'x')
      expect.unreachable('expected a refusal')
    } catch (error) {
      expect((error as Error).cause).toBeDefined()
      expect(String((error as { cause?: unknown }).cause)).toMatch(/integer number of fils/)
    }
  })

  it('refuses a blank reference and a whitespace one, which are the same mistake', () => {
    expect(() => assertReferencePresent('')).toThrow(GatewayReferenceMissing)
    expect(() => assertReferencePresent('   ')).toThrow(GatewayReferenceMissing)
  })

  it('refuses an instrument a gateway does not serve, naming what it does serve', () => {
    expect(() => assertServesInstrument('till', ['cash'], 'card_online')).toThrow(
      GatewayDoesNotServeInstrument,
    )
    expect(() => assertServesInstrument('till', ['cash'], 'card_online')).toThrow(/takes cash/)
  })

  it('the control: a served instrument, a present reference and an integer amount all pass', () => {
    // Without this, the three refusals above are satisfied by guards that refuse everything.
    expect(() => assertServesInstrument('till', ['cash'], 'cash')).not.toThrow()
    expect(() => assertReferencePresent('INV-0001')).not.toThrow()
    expect(() => assertIntegerFilsAmount(aed(350), 'the amount captured')).not.toThrow()
  })
})

describe('the gateway tender kind this unit adds', () => {
  it('is in the registry with the gateway adapter and the gateway clearing account', () => {
    // Migration 0105's row, from the core side. `packages/fixtures/src/payment.itest.ts` holds the same
    // claim against the database, in both directions.
    expect(TENDER_KINDS).toContain('card_online')
    const spec = TENDER_TYPES['card_online']
    expect(spec.adapter).toBe('gateway')
    expect(spec.account).toBe('1030')
    expect(spec.settlesImmediately).toBe(false)
    expect(spec.requiresReference).toBe(true)
    expect(spec.givesChange).toBe(false)
  })

  it('is the only kind whose adapter is the gateway', () => {
    // The control on the other three: adding the fourth must not have moved any of them.
    expect(TENDER_KINDS.filter((kind) => TENDER_TYPES[kind].adapter === 'gateway')).toEqual([
      'card_online',
    ])
  })

  it('does not share a clearing account with the in-salon terminal', () => {
    // One account holding both streams reconciles against neither statement on its own.
    expect(TENDER_TYPES['card_online'].account).not.toBe(TENDER_TYPES['card_in_salon'].account)
  })
})

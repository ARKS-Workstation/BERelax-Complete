import type {
  AuthoriseRequest,
  CaptureRequest,
  Currency,
  Fils,
  GatewayIntentSnapshot,
  GatewayMovementRecord,
  GatewayRefundReceipt,
  IntegerLiteral,
  Money,
  PaymentGatewayMembersAreExact,
  RefundRequest,
} from '@berelax/core'
import {
  aedFrom,
  filsFrom,
  PAYMENT_GATEWAY_MEMBERS_ARE_EXACT,
  PAYMENT_GATEWAY_OPERATION_MEMBERS,
} from '@berelax/core'
import { describe, expect, it } from 'vitest'

/**
 * The type-level half of "every port method takes and returns integer-fils `Money` with explicit currency".
 *
 * ## Why this file is types and not only assertions
 *
 * The acceptance line asks for a **compile error**, and a runtime test cannot observe one: by the time
 * vitest runs, `tsc` has not been consulted at all — it transpiles (brief rule 28). So the claim is made in
 * three places, and all three are needed:
 *
 *   1. **Here, as types that resolve to `true`.** Each `const` below is annotated `true`, so a type that
 *      resolves to `false` fails `pnpm typecheck` in this file. That is the compile error, expressed as
 *      something a reader can see rather than as a comment saying it would happen.
 *   2. **Here, as runtime assertions**, so the file is not a silent pass if somebody widens a type to
 *      `unknown` and every check trivially holds. The `it` blocks read the same constants, so a file that
 *      stopped type-checking anything still has to produce the right values.
 *   3. **In gate block 133**, which writes a fixture assigning a float where `Money` is wanted and requires
 *      `pnpm typecheck` to FAIL. That is the direction neither of the first two can prove: a type-level
 *      check that has never been seen to reject anything is ADR 0003's defect in a type system.
 */

/** Reads as `true` only if `A` and `B` are the same type. Invariant, so it catches a widening. */
type Exact<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

/** Reads as `true` when `From` is NOT assignable to `To` — i.e. the assignment would not compile. */
type NotAssignable<From, To> = [From] extends [To] ? false : true

// --- the fractional literal ---------------------------------------------------------------------

/**
 * `aed(1.5)` and `fils(1.5)` do not compile, because `IntegerLiteral<1.5>` is `never`.
 *
 * ADR 0007's mechanism, asserted rather than described: `` `${1.5}` `` is `"1.5"`, which does not extend
 * `` `${bigint}` ``. This is the check that would have to be deleted for a float literal to become legal.
 */
const FRACTIONAL_LITERAL_IS_NEVER: Exact<IntegerLiteral<1.5>, never> = true
const INTEGER_LITERAL_SURVIVES: Exact<IntegerLiteral<350>, 350> = true

// --- a bare number is not an amount -------------------------------------------------------------

/** A plain `number` never crosses this port. Every amount is `{ fils, currency }`. */
const NUMBER_IS_NOT_AN_AUTHORISE_AMOUNT: NotAssignable<number, AuthoriseRequest['amount']> = true
const NUMBER_IS_NOT_A_CAPTURE_AMOUNT: NotAssignable<number, CaptureRequest['amount']> = true
const NUMBER_IS_NOT_A_REFUND_AMOUNT: NotAssignable<number, RefundRequest['amount']> = true

/**
 * A fractional `fils` is not `Money` even inside an object literal, because `Fils` is branded.
 *
 * This is the case a request body actually produces: nobody writes `aed(1.5)`, they write
 * `{ fils: body.amount, currency: 'AED' }` and `body.amount` is whatever arrived. The brand is what makes
 * that a cast the reader can see rather than an assignment that compiles.
 */
const FRACTIONAL_OBJECT_IS_NOT_MONEY: NotAssignable<{ fils: 1.5; currency: 'AED' }, Money> = true
const PLAIN_INTEGER_OBJECT_IS_NOT_MONEY: NotAssignable<{ fils: 350; currency: 'AED' }, Money> = true

/** And a `Money` with no currency is not `Money`: the currency is explicit on every amount. */
const CURRENCYLESS_IS_NOT_MONEY: NotAssignable<{ fils: Fils }, Money> = true

// --- every amount on the port is Money ----------------------------------------------------------

/**
 * Each amount-bearing field is exactly `Money`, not a supertype.
 *
 * `Exact` rather than assignability, because `Money | number` accepts `Money` and would pass an
 * assignability check while letting a bare number through at the call site.
 */
const AUTHORISE_AMOUNT_IS_MONEY: Exact<AuthoriseRequest['amount'], Money> = true
const CAPTURE_AMOUNT_IS_MONEY: Exact<CaptureRequest['amount'], Money> = true
const REFUND_AMOUNT_IS_MONEY: Exact<RefundRequest['amount'], Money> = true
const SNAPSHOT_AUTHORISED_IS_MONEY: Exact<GatewayIntentSnapshot['authorised'], Money> = true
const SNAPSHOT_CAPTURED_IS_MONEY: Exact<GatewayIntentSnapshot['captured'], Money> = true
const SNAPSHOT_REFUNDED_IS_MONEY: Exact<GatewayIntentSnapshot['refunded'], Money> = true
const RECEIPT_AMOUNT_IS_MONEY: Exact<GatewayRefundReceipt['amount'], Money> = true
const MOVEMENT_AMOUNT_IS_MONEY: Exact<GatewayMovementRecord['amount'], Money> = true

/** The currency is the closed set, so a third currency is a decision and not a string. */
const CURRENCY_IS_CLOSED: Exact<Currency, 'AED'> = true

/** The member list cannot go stale in either direction. */
const MEMBERS_ARE_EXACT: Exact<PaymentGatewayMembersAreExact, true> = true

describe('the port carries integer-fils Money and nothing else', () => {
  it('holds every type-level claim in this file', () => {
    // Reading the constants is what stops this file passing vacuously: if a claim above is widened so that
    // its type resolves to `false`, `tsc` fails; if the whole file stops being type-checked, these still
    // have to be `true`, and a `false` annotated as `true` cannot be.
    for (const claim of [
      FRACTIONAL_LITERAL_IS_NEVER,
      INTEGER_LITERAL_SURVIVES,
      NUMBER_IS_NOT_AN_AUTHORISE_AMOUNT,
      NUMBER_IS_NOT_A_CAPTURE_AMOUNT,
      NUMBER_IS_NOT_A_REFUND_AMOUNT,
      FRACTIONAL_OBJECT_IS_NOT_MONEY,
      PLAIN_INTEGER_OBJECT_IS_NOT_MONEY,
      CURRENCYLESS_IS_NOT_MONEY,
      AUTHORISE_AMOUNT_IS_MONEY,
      CAPTURE_AMOUNT_IS_MONEY,
      REFUND_AMOUNT_IS_MONEY,
      SNAPSHOT_AUTHORISED_IS_MONEY,
      SNAPSHOT_CAPTURED_IS_MONEY,
      SNAPSHOT_REFUNDED_IS_MONEY,
      RECEIPT_AMOUNT_IS_MONEY,
      MOVEMENT_AMOUNT_IS_MONEY,
      CURRENCY_IS_CLOSED,
      MEMBERS_ARE_EXACT,
    ]) {
      expect(claim).toBe(true)
    }
  })

  it('keeps the runtime member list equal to the interface', () => {
    expect(PAYMENT_GATEWAY_MEMBERS_ARE_EXACT).toBe(true)
    expect([...PAYMENT_GATEWAY_OPERATION_MEMBERS]).toEqual([
      'authorise',
      'capture',
      'refund',
      'voidAuthorisation',
      'fetchIntent',
      'eventsSince',
    ])
  })

  it('refuses a fractional amount at runtime too, where the type system is no longer looking', () => {
    // The complement of the type-level half: a value that arrived in a request body has been through a cast.
    expect(() => filsFrom(12.5)).toThrow(/must be an integer number of fils/)
    expect(() => aedFrom(1.5)).toThrow(/must be an integer/)
  })

  it('the control: an integer amount is accepted', () => {
    // Without this the two refusals above are satisfied by a constructor that rejects everything.
    expect(filsFrom(26_250)).toBe(26_250)
    expect(aedFrom(350).fils).toBe(35_000)
  })
})

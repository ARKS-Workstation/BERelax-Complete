import { describe, expect, it } from 'vitest'
import { cancellationCharge } from '../lifecycle/cancellation-policy.ts'
import type { Instant } from '../time.ts'
import { instantFromIso } from '../time.ts'
import {
  assertFeeChargeable,
  FEE_CHARGE_SETTING_KEY,
  FEE_POLICY_OPEN_QUESTION,
  FeeExceedsMandateCap,
  feeChargePolicy,
  MANDATE_STATES,
  MANDATE_TOKEN_REFERENCE_RULE,
  MandateExpired,
  type MandateRecord,
  MandateRevoked,
  mandateHeadroomFils,
  mandateStateAt,
  NoFeePolicyOnFile,
  NoMandateOnFile,
  noShowOutcome,
  PROVISIONAL_FEE_POLICY,
} from './fee-policy.ts'

/**
 * Y-PAY-07's arithmetic and its five refusals, with the control for each.
 *
 * The unit's whole subject is that a charge nobody has authorised must be impossible to make, so almost
 * every case here asserts a THROW — and a suite of throws is the easiest kind to make pass vacuously, by
 * a guard that refuses everything for the wrong reason. So every refusal is paired with the input that
 * must get PAST it, which is what makes "this guard refused" distinguishable from "this function throws".
 *
 * The order of the checks inside `assertFeeChargeable` is itself asserted, in
 * `the policy gate fires last`. That looks like testing an implementation detail and is not: if the policy
 * gate fired first, four of this unit's five acceptance refusals would be unreachable today and would be
 * code nobody had ever seen run.
 */

const AGREED = instantFromIso('2099-01-10T12:00:00+04:00')
const EXPIRES = instantFromIso('2099-04-10T12:00:00+04:00')
const INSIDE = instantFromIso('2099-02-01T12:00:00+04:00')
const AFTER = instantFromIso('2099-05-01T12:00:00+04:00')
const REVOKED = instantFromIso('2099-02-15T12:00:00+04:00')

/** AED 50.00. A figure the test chose; no policy produced it (Y9-windows). */
const CAP = 5_000

function mandate(overrides: Partial<MandateRecord> = {}): MandateRecord {
  return {
    mandateId: 'mandate-under-test',
    customerId: 'customer-under-test',
    gateway: 'gateway-not-chosen',
    tokenReference: 'tok_opaque_handle',
    wordingVersion: 'mandate-wording-under-test',
    wordingSha256: 'a'.repeat(64),
    capFils: CAP,
    agreedAt: AGREED,
    expiresAt: EXPIRES,
    revokedAt: null,
    ...overrides,
  }
}

/** A policy that IS on file, which no setting in this build produces. Used only as a control. */
const POLICY_ON_FILE = feeChargePolicy({ onFile: true })

describe('the provisional policy', () => {
  it('is not on file, and says so rather than reporting a fee of zero', () => {
    expect(PROVISIONAL_FEE_POLICY.onFile).toBe(false)
    expect(PROVISIONAL_FEE_POLICY.openQuestionId).toBe(FEE_POLICY_OPEN_QUESTION)
    // The control. A policy object with no figure on it is what makes the refusal the only answer: a
    // `feeFils: 0` field here would be summed into a "fees charged" total by something downstream.
    expect(Object.keys(PROVISIONAL_FEE_POLICY)).not.toContain('feeFils')
  })

  it('reads a stored value rather than coercing it, so a corrupt row lands on the OFF reading', () => {
    expect(feeChargePolicy({ onFile: 'true' }).onFile).toBe(false)
    expect(feeChargePolicy({ onFile: 1 }).onFile).toBe(false)
    expect(feeChargePolicy({ onFile: {} }).onFile).toBe(false)
    expect(feeChargePolicy({ onFile: undefined }).onFile).toBe(false)
    // The control: the ONE accepted shape. Without it every assertion above is satisfied by a function
    // that returns false for every input, which would also make the day a policy is agreed a silent
    // no-op.
    expect(feeChargePolicy({ onFile: true }).onFile).toBe(true)
  })

  it('names the setting an audited change would have to move, and does not read it here', () => {
    expect(FEE_CHARGE_SETTING_KEY).toBe('payments.cancellation_fee_charging_enabled')
    expect(PROVISIONAL_FEE_POLICY.why).toContain('no fee policy')
  })

  it('agrees with `cancellationCharge()`, which is the one seam a fee would arrive through', () => {
    // Not a restatement of B-LIFE-03's own test: the claim here is that the two modules have not drifted
    // into disagreeing, so that a fee figure cannot exist while the policy says none does.
    expect(cancellationCharge().fils).toBe(0)
    expect(PROVISIONAL_FEE_POLICY.onFile).toBe(false)
  })
})

describe('a mandate state', () => {
  it('is active between agreement and expiry', () => {
    expect(mandateStateAt(mandate(), INSIDE)).toBe('active')
  })

  it('is expired from the expiry instant, which is exclusive', () => {
    expect(mandateStateAt(mandate(), EXPIRES)).toBe('expired')
    expect(mandateStateAt(mandate(), AFTER)).toBe('expired')
    // The control for the boundary: one millisecond earlier is still authority.
    expect(mandateStateAt(mandate(), ((EXPIRES as number) - 1) as Instant)).toBe('active')
  })

  it('is revoked from the revocation instant, and revocation beats expiry when both apply', () => {
    const taken = mandate({ revokedAt: REVOKED })
    expect(mandateStateAt(taken, REVOKED)).toBe('revoked')
    expect(mandateStateAt(taken, AFTER)).toBe('revoked')
    // The control, and the reason the order is not arbitrary: at `AFTER` the mandate is ALSO expired, and
    // reporting it as merely expired would lose the one fact that changes what may be said to the
    // customer next.
    expect(mandateStateAt(mandate(), AFTER)).toBe('expired')
    // And a revocation does not reach backwards: an attempt before it was authorised.
    expect(mandateStateAt(taken, INSIDE)).toBe('active')
  })

  it('has exactly three states, so a caller cannot forget one', () => {
    expect([...MANDATE_STATES]).toEqual(['active', 'expired', 'revoked'])
  })
})

describe('assertFeeChargeable', () => {
  it('refuses when no mandate is on file', () => {
    expect(() =>
      assertFeeChargeable({
        mandate: null,
        customerId: 'customer-under-test',
        requestedFils: 1_000,
        at: INSIDE,
        policy: POLICY_ON_FILE,
      }),
    ).toThrow(NoMandateOnFile)
  })

  it('refuses an expired mandate', () => {
    expect(() =>
      assertFeeChargeable({
        mandate: mandate(),
        customerId: 'customer-under-test',
        requestedFils: 1_000,
        at: AFTER,
        policy: POLICY_ON_FILE,
      }),
    ).toThrow(MandateExpired)
  })

  it('refuses a revoked mandate, and the revocation takes effect on the NEXT attempt', () => {
    const taken = mandate({ revokedAt: REVOKED })
    // Before the revocation: authorised, and the policy gate is the only thing in the way.
    expect(() =>
      assertFeeChargeable({
        mandate: taken,
        customerId: 'customer-under-test',
        requestedFils: 1_000,
        at: INSIDE,
        policy: POLICY_ON_FILE,
      }),
    ).not.toThrow()
    // After it: refused by name. This pair IS the acceptance line "a revocation takes effect on the next
    // charge attempt" — a single assertion would be satisfied by a guard that refused both.
    expect(() =>
      assertFeeChargeable({
        mandate: taken,
        customerId: 'customer-under-test',
        requestedFils: 1_000,
        at: AFTER,
        policy: POLICY_ON_FILE,
      }),
    ).toThrow(MandateRevoked)
  })

  it('refuses a figure above the cap, and names both numbers', () => {
    let caught: unknown
    try {
      assertFeeChargeable({
        mandate: mandate(),
        customerId: 'customer-under-test',
        requestedFils: CAP + 1,
        at: INSIDE,
        policy: POLICY_ON_FILE,
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(FeeExceedsMandateCap)
    expect((caught as FeeExceedsMandateCap).capFils).toBe(CAP)
    expect((caught as FeeExceedsMandateCap).requestedFils).toBe(CAP + 1)
    // The control for the boundary: exactly the cap is what the customer agreed to, so it passes the cap
    // check. A `>=` here would refuse the one figure the mandate was taken for.
    expect(() =>
      assertFeeChargeable({
        mandate: mandate(),
        customerId: 'customer-under-test',
        requestedFils: CAP,
        at: INSIDE,
        policy: POLICY_ON_FILE,
      }),
    ).not.toThrow()
  })

  it('refuses rather than answering zero when no policy is on file', () => {
    let caught: unknown
    try {
      assertFeeChargeable({
        mandate: mandate(),
        customerId: 'customer-under-test',
        requestedFils: 1_000,
        at: INSIDE,
        policy: PROVISIONAL_FEE_POLICY,
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(NoFeePolicyOnFile)
    // The sentence that distinguishes this refusal from a validation failure, and the one a reviewer
    // reading the audit trail needs: it is not that the figure was wrong.
    expect((caught as Error).message).toContain('not a charge of zero fils')
    expect((caught as Error).message).toContain(FEE_CHARGE_SETTING_KEY)
  })

  it('refuses a figure that is not a figure, before it refuses anything else', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        assertFeeChargeable({
          mandate: mandate(),
          customerId: 'customer-under-test',
          requestedFils: bad,
          at: INSIDE,
          policy: POLICY_ON_FILE,
        }),
      ).toThrow(/not a chargeable figure/)
    }
  })

  it('fires the policy gate LAST, so the cap and revocation rules stay reachable today', () => {
    // The whole point of the ordering, asserted with the provisional policy in force — which is the only
    // policy this build has. If the policy gate ran first, every one of these would be
    // `NoFeePolicyOnFile` and four acceptance refusals would be untestable until a fee policy existed.
    expect(() =>
      assertFeeChargeable({
        mandate: mandate(),
        customerId: 'customer-under-test',
        requestedFils: CAP + 1,
        at: INSIDE,
        policy: PROVISIONAL_FEE_POLICY,
      }),
    ).toThrow(FeeExceedsMandateCap)
    expect(() =>
      assertFeeChargeable({
        mandate: mandate({ revokedAt: REVOKED }),
        customerId: 'customer-under-test',
        requestedFils: 1_000,
        at: AFTER,
        policy: PROVISIONAL_FEE_POLICY,
      }),
    ).toThrow(MandateRevoked)
    // And the control that proves the policy gate is still THERE: a request that passes every other
    // check is refused by it and by nothing else.
    expect(() =>
      assertFeeChargeable({
        mandate: mandate(),
        customerId: 'customer-under-test',
        requestedFils: 1_000,
        at: INSIDE,
        policy: PROVISIONAL_FEE_POLICY,
      }),
    ).toThrow(NoFeePolicyOnFile)
  })

  it('refuses every charge this build can actually ask for', () => {
    // The unit's summary line, as one assertion over the real policy: there is no input for which a
    // charge is authorised. The control is the preceding case, where the same inputs pass under a policy
    // that is on file — without it this case would also pass for a function that threw unconditionally.
    for (const at of [INSIDE, AFTER]) {
      for (const requested of [1, CAP, CAP + 1]) {
        for (const m of [null, mandate(), mandate({ revokedAt: REVOKED })]) {
          expect(() =>
            assertFeeChargeable({
              mandate: m,
              customerId: 'customer-under-test',
              requestedFils: requested,
              at,
              policy: PROVISIONAL_FEE_POLICY,
            }),
          ).toThrow()
        }
      }
    }
  })
})

describe('a no-show under the provisional policy', () => {
  it('is a flag, and posts nothing', () => {
    const outcome = noShowOutcome({
      appointmentId: 'appointment-under-test',
      policy: PROVISIONAL_FEE_POLICY,
    })
    expect(outcome.flagged).toBe(true)
    expect(outcome.paymentIntentsCreated).toBe(0)
    expect(outcome.journalEntriesCreated).toBe(0)
  })

  it('reports the fee as ABSENT and never as zero', () => {
    const outcome = noShowOutcome({
      appointmentId: 'appointment-under-test',
      policy: PROVISIONAL_FEE_POLICY,
    })
    // ADR 0070's distinction, as the one assertion that would fail if somebody "tidied" this to `0`: a
    // zero is a figure and gets summed; null is the absence of one and refuses to be.
    expect(outcome.feeFils).toBeNull()
    expect(outcome.feeFils).not.toBe(0)
    expect(outcome.openQuestionId).toBe(FEE_POLICY_OPEN_QUESTION)
  })
})

describe('the token reference rule', () => {
  it('is stated once, as the sentence the database quotes back', () => {
    // The two statements of this rule are in two languages — this constant and migration 0134's ZY423 —
    // and `packages/fixtures/src/mandate.itest.ts` is where they are held equal. Here the claim is only
    // that the rule names the shape rather than naming a column.
    expect(MANDATE_TOKEN_REFERENCE_RULE).toContain('Luhn-valid')
    expect(MANDATE_TOKEN_REFERENCE_RULE).toContain('13-to-19-digit')
  })
})

describe('the cap', () => {
  it('is a per-charge maximum and not a running budget', () => {
    expect(mandateHeadroomFils(mandate())).toBe(CAP)
  })
})

import {
  type FeeChargePolicy,
  FeeExceedsMandateCap,
  feeChargePolicy,
  type Instant,
  instantFromIso,
  MandateRevoked,
  NoFeePolicyOnFile,
  NoMandateOnFile,
  PROVISIONAL_FEE_POLICY,
} from '@berelax/core'
import { describe, expect, it } from 'vitest'
import {
  activeMandateAmong,
  attemptFeeCharge,
  CHARGE_OUTCOMES,
  type ChargeOutcome,
  type MandateDeps,
  outcomeForRefusal,
  type StoredMandate,
} from './mandate.ts'

/**
 * The mandate service, driven over fakes.
 *
 * The seams are functions, so every branch of {@link attemptFeeCharge} is reachable here without a
 * PostgreSQL — and the thing worth proving at this layer is not the arithmetic (that is
 * `fee-policy.test.ts`) but the ORDER: that the attempt is recorded before the refusal is rethrown, and
 * that it is recorded under the rule that actually fired. A log written after a rethrow is a log nobody
 * writes, and an attempt logged under the wrong outcome is worse than one not logged at all, because an
 * operator reading "no policy on file" would not know the customer had been asked for too much.
 */

const AGREED = instantFromIso('2099-01-10T12:00:00+04:00')
const EXPIRES = instantFromIso('2099-04-10T12:00:00+04:00')
const INSIDE = instantFromIso('2099-02-01T12:00:00+04:00')
const AFTER = instantFromIso('2099-05-01T12:00:00+04:00')
const REVOKED = instantFromIso('2099-02-15T12:00:00+04:00')

const CAP = 5_000
const POLICY_ON_FILE: FeeChargePolicy = feeChargePolicy({ onFile: true })

function stored(overrides: Partial<StoredMandate> = {}): StoredMandate {
  return {
    mandateId: 'mandate-under-test',
    customerId: 'customer-under-test',
    gateway: 'gateway-not-chosen',
    capFils: CAP,
    wordingVersion: 'mandate-wording-under-test',
    agreedAtMs: AGREED as number,
    expiresAtMs: EXPIRES as number,
    revokedAtMs: null,
    ...overrides,
  }
}

interface Recorded {
  readonly outcome: ChargeOutcome
  readonly requestedFils: number
  readonly mandateId: string
}

function deps(
  mandates: readonly StoredMandate[],
  log: Recorded[],
  policyInDatabase = false,
): MandateDeps {
  return {
    mandatesForCustomer: async () => mandates,
    recordMandate: async () => 'mandate-recorded',
    revokeMandate: async () => undefined,
    logChargeAttempt: async (input) => {
      log.push({
        outcome: input.outcome,
        requestedFils: input.requestedFils,
        mandateId: input.mandateId,
      })
      // The database's own gate, as the fake can state it: ZY426 refuses a `charged` row while no policy
      // is on file. The fake refuses it too, so a test cannot pass here and fail against PostgreSQL.
      if (input.outcome === 'charged' && !policyInDatabase) {
        throw Object.assign(new Error('NoFeePolicyOnFile'), { code: 'ZY426' })
      }
      return 'attempt-recorded'
    },
    feePolicyIsOnFile: async () => policyInDatabase,
  }
}

describe('activeMandateAmong', () => {
  it('is null when the customer has none', () => {
    expect(activeMandateAmong([], INSIDE)).toBeNull()
  })

  it('picks the newest ACTIVE mandate, not simply the newest', () => {
    const older = stored({ mandateId: 'older', agreedAtMs: (AGREED as number) - 1_000 })
    const newerButRevoked = stored({ mandateId: 'newer', revokedAtMs: REVOKED as number })
    const chosen = activeMandateAmong([older, newerButRevoked], AFTER_REVOCATION)
    // The newer one is revoked at this instant, so the older one is the authority. A "newest wins"
    // implementation would hand the gate a revoked mandate and the refusal would name the wrong row.
    expect(chosen?.mandateId).toBe('older')
  })

  it('re-sorts rather than trusting the caller’s order', () => {
    const older = stored({ mandateId: 'older', agreedAtMs: (AGREED as number) - 1_000 })
    const newer = stored({ mandateId: 'newer' })
    // Deliberately handed oldest-first, which is the order a later query change could produce.
    expect(activeMandateAmong([older, newer], INSIDE)?.mandateId).toBe('newer')
  })

  it('is null when every mandate has lapsed', () => {
    expect(activeMandateAmong([stored()], AFTER)).toBeNull()
  })
})

/** Between the revocation and the expiry, so "revoked" and "expired" are distinguishable. */
const AFTER_REVOCATION = instantFromIso('2099-03-01T12:00:00+04:00') as Instant

describe('outcomeForRefusal', () => {
  it('maps each refusal to the outcome that names the rule that fired', () => {
    expect(outcomeForRefusal(new FeeExceedsMandateCap('m', CAP, CAP + 1))).toBe('refused_cap')
    expect(outcomeForRefusal(new MandateRevoked('m', REVOKED as number))).toBe('refused_not_active')
    expect(outcomeForRefusal(new NoFeePolicyOnFile('a charge', PROVISIONAL_FEE_POLICY))).toBe(
      'refused_no_policy',
    )
  })

  it('throws rather than defaulting for a refusal it has never seen', () => {
    // The case the `Map` exists for. An `if`-chain would fall through to `refused_no_policy` and record a
    // cap breach as a missing policy, which is a wrong entry in the one log an operator would read.
    expect(() => outcomeForRefusal(new Error('a refusal added later'))).toThrow(
      /no recorded charge outcome/,
    )
  })

  it('has no entry for NoMandateOnFile, because there is no row to hang an attempt off', () => {
    expect(() => outcomeForRefusal(new NoMandateOnFile('customer-under-test'))).toThrow()
  })

  it('covers every outcome the table admits except the one a refusal cannot produce', () => {
    const mapped = new Set<ChargeOutcome>([
      outcomeForRefusal(new FeeExceedsMandateCap('m', CAP, CAP + 1)),
      outcomeForRefusal(new MandateRevoked('m', REVOKED as number)),
      outcomeForRefusal(new NoFeePolicyOnFile('a charge', PROVISIONAL_FEE_POLICY)),
    ])
    expect([...mapped].sort()).toEqual(['refused_cap', 'refused_no_policy', 'refused_not_active'])
    expect([...CHARGE_OUTCOMES]).toContain('charged')
  })
})

describe('attemptFeeCharge', () => {
  it('refuses and logs nothing when the customer has no mandate', async () => {
    const log: Recorded[] = []
    await expect(
      attemptFeeCharge(
        deps([], log),
        {
          customerId: 'customer-under-test',
          appointmentId: 'appointment-under-test',
          reason: 'no_show',
          requestedFils: 1_000,
          at: INSIDE,
          tradingDate: '2099-02-01',
        },
        PROVISIONAL_FEE_POLICY,
      ),
    ).rejects.toThrow(NoMandateOnFile)
    // An attempt against a mandate that does not exist is not an attempt the system made; it is a request
    // that never reached one. A row here would be a foreign key to nothing.
    expect(log).toHaveLength(0)
  })

  it('records the attempt BEFORE it rethrows, under the rule that fired', async () => {
    const log: Recorded[] = []
    await expect(
      attemptFeeCharge(
        deps([stored()], log),
        {
          customerId: 'customer-under-test',
          appointmentId: 'appointment-under-test',
          reason: 'late_cancellation',
          requestedFils: CAP + 1,
          at: INSIDE,
          tradingDate: '2099-02-01',
        },
        POLICY_ON_FILE,
      ),
    ).rejects.toThrow(FeeExceedsMandateCap)
    // Both halves matter. That the row exists is "we tried and the system stopped us"; that its outcome
    // is `refused_cap` and not `refused_no_policy` is what makes the log answerable.
    expect(log).toEqual([
      { outcome: 'refused_cap', requestedFils: CAP + 1, mandateId: 'mandate-under-test' },
    ])
  })

  it('logs a revoked mandate under refused_not_active, against the mandate that exists', async () => {
    const log: Recorded[] = []
    await expect(
      attemptFeeCharge(
        deps([stored({ revokedAtMs: REVOKED as number })], log),
        {
          customerId: 'customer-under-test',
          appointmentId: 'appointment-under-test',
          reason: 'no_show',
          requestedFils: 1_000,
          at: AFTER_REVOCATION,
          tradingDate: '2099-03-01',
        },
        POLICY_ON_FILE,
      ),
    ).rejects.toThrow(MandateRevoked)
    expect(log[0]?.outcome).toBe('refused_not_active')
    // The row the attempt hangs off is the mandate the customer actually has, revoked or not. Logging
    // against nothing would lose the one link an operator follows.
    expect(log[0]?.mandateId).toBe('mandate-under-test')
  })

  it('is refused by the DATABASE even if the pure gate were somehow satisfied', async () => {
    const log: Recorded[] = []
    // `POLICY_ON_FILE` is a policy no setting in this build produces, so this is the state in which the
    // TypeScript gate would let a charge through. The fake answers as ZY426 does, which is the whole
    // point: the screen's validation is not the refusal.
    await expect(
      attemptFeeCharge(
        deps([stored()], log, false),
        {
          customerId: 'customer-under-test',
          appointmentId: 'appointment-under-test',
          reason: 'no_show',
          requestedFils: 1_000,
          at: INSIDE,
          tradingDate: '2099-02-01',
        },
        POLICY_ON_FILE,
      ),
    ).rejects.toThrow(/ZY426|NoFeePolicyOnFile/)
    expect(log[0]?.outcome).toBe('charged')
  })

  it('is the one path that succeeds, and only when BOTH layers agree a policy exists', async () => {
    const log: Recorded[] = []
    // The control. Without it every assertion above is satisfied by a function that always throws, and
    // the day a fee policy is agreed nothing here would have changed.
    await expect(
      attemptFeeCharge(
        deps([stored()], log, true),
        {
          customerId: 'customer-under-test',
          appointmentId: 'appointment-under-test',
          reason: 'no_show',
          requestedFils: 1_000,
          at: INSIDE,
          tradingDate: '2099-02-01',
        },
        POLICY_ON_FILE,
      ),
    ).resolves.toBe('attempt-recorded')
    expect(log[0]?.outcome).toBe('charged')
  })

  it('refuses under the policy this build actually has, for every mandate state', async () => {
    for (const [at, mandates] of [
      [INSIDE, [stored()]],
      [AFTER, [stored()]],
      [AFTER_REVOCATION, [stored({ revokedAtMs: REVOKED as number })]],
    ] as const) {
      const log: Recorded[] = []
      await expect(
        attemptFeeCharge(
          deps(mandates, log),
          {
            customerId: 'customer-under-test',
            appointmentId: 'appointment-under-test',
            reason: 'no_show',
            requestedFils: 1_000,
            at,
            tradingDate: '2099-02-01',
          },
          PROVISIONAL_FEE_POLICY,
        ),
      ).rejects.toThrow()
      expect(log[0]?.outcome).not.toBe('charged')
    }
  })
})

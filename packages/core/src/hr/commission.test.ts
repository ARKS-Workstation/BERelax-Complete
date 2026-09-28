import { describe, expect, it } from 'vitest'
import { type LocalDate, localDate } from '../time.ts'
import {
  assertCommissionRuleVersion,
  assertMayReadCommissionDerivation,
  COMMISSION_ROUNDING_MODES,
  type CommissionEarning,
  type CommissionRuleVersion,
  commissionBandFor,
  commissionBasisFilsFor,
  commissionFilsFor,
  commissionRuleFor,
  computeCommission,
  MAX_COMMISSION_BASIS_FILS,
  mayReadCommissionDerivation,
  planCommissionRun,
} from './commission.ts'

/**
 * The commission engine by worked example, and every refusal shown to fire.
 *
 * **Every figure in this file is this file's own.** `commission_rule` (0097) seeds no version, because
 * Y9-commission is open and its provisional answer is that no commission structure is configured. So the
 * rates below are a FIXTURE rule set, not the build's assumption about what this business pays, and nothing
 * here may be read as one. That is also why the versions are constructed in the test rather than imported
 * from a shared constant: a shared "the rate" is how a fixture figure becomes a business fact.
 *
 * The rounding cases are worked out on paper in the comments, which is the point of a worked example: a
 * property test cannot be checked by a reader and `./commission.property.test.ts` does not try to be.
 */

/** A flat 10% of net, rounding down. One band from zero, which is what "flat" is in this schema. */
const FLAT_TEN_PERCENT: CommissionRuleVersion = {
  ruleVersionId: 'fixture-version-1',
  version: 1,
  effectiveFrom: localDate('2081-01-01'),
  basis: 'net_of_vat',
  roundingMode: 'floor',
  bands: [{ bandNo: 1, fromFils: 0, rateBp: 1_000 }],
}

/** Two bands, so the band selection has something to select. 5% below 20,000 fils, 12% at or above it. */
const TIERED: CommissionRuleVersion = {
  ruleVersionId: 'fixture-version-2',
  version: 2,
  effectiveFrom: localDate('2081-06-01'),
  basis: 'gross_inclusive',
  roundingMode: 'half_up',
  bands: [
    { bandNo: 1, fromFils: 0, rateBp: 500 },
    { bandNo: 2, fromFils: 20_000, rateBp: 1_200 },
  ],
}

const earning = (over: Partial<CommissionEarning> = {}): CommissionEarning => ({
  appointmentId: 'appointment-b',
  employeeId: 'employee-1',
  tradingDate: localDate('2081-03-14'),
  source: 'invoice_line',
  invoiceId: 'invoice-1',
  packageRedemptionId: null,
  grossFils: 26_250,
  vatFils: 1_250,
  ...over,
})

describe('commissionFilsFor — integer arithmetic, with the direction the version names', () => {
  it('floors, and the worked example is one a reader can check', () => {
    // 10% of 25,000 fils is exactly 2,500. Nothing to round: the control for the two below.
    expect(commissionFilsFor(25_000, 1_000, 'floor')).toBe(2_500)
    // 10% of 9,999 fils is 999.9, which floors to 999.
    expect(commissionFilsFor(9_999, 1_000, 'floor')).toBe(999)
    // And the case that catches dividing before multiplying: 1% of 9,900 fils is 99, not 0.
    expect(commissionFilsFor(9_900, 100, 'floor')).toBe(99)
    expect(Math.floor(9_900 / 10_000) * 100).toBe(0)
  })

  it('rounds half up when the version says so, and the tie goes up', () => {
    // 1% of 9,950 fils is 99.5 exactly — the tie. Half-up is 100, floor is 99, and the two differ by
    // the fil that makes the rounding direction a figure somebody has to state.
    expect(commissionFilsFor(9_950, 100, 'half_up')).toBe(100)
    expect(commissionFilsFor(9_950, 100, 'floor')).toBe(99)
    // Just under the tie stays down, which is what makes the boundary the stated one.
    expect(commissionFilsFor(9_949, 100, 'half_up')).toBe(99)
  })

  it('answers 0 for a 0% band and the whole basis for a 100% one', () => {
    expect(commissionFilsFor(26_250, 0, 'floor')).toBe(0)
    expect(commissionFilsFor(26_250, 10_000, 'floor')).toBe(26_250)
  })

  it('refuses a basis or a rate that is not a figure, and a rounding mode nobody implemented', () => {
    expect(() => commissionFilsFor(-1, 1_000, 'floor')).toThrow(/not a value/)
    expect(() => commissionFilsFor(1_000.5, 1_000, 'floor')).toThrow(/integer fils/)
    expect(() => commissionFilsFor(1_000, 10_001, 'floor')).toThrow(/outside 0\.\.10000/)
    expect(() => commissionFilsFor(1_000, -1, 'floor')).toThrow(/outside 0\.\.10000/)
    // A mode the schema does not admit. Cast, because the type is what normally prevents this — and the
    // reason to test it anyway is that the value arrives from a database column at run time, where the
    // type is a claim about the migration rather than a guarantee.
    expect(() => commissionFilsFor(1_000, 1_000, 'bankers' as unknown as 'floor')).toThrow(
      /not a commission rounding mode/,
    )
    // The CONTROL: both modes the schema does admit are implemented, so the refusal above is about the
    // unknown value and not about a function that has stopped answering.
    for (const mode of COMMISSION_ROUNDING_MODES) {
      expect(commissionFilsFor(1_000, 1_000, mode)).toBe(100)
    }
  })

  it('refuses a basis above the exact-integer bound rather than answering inexactly', () => {
    // At 10,000 basis points the product is 10^4 times the basis, so above this the multiplication stops
    // being exact — and an inexact multiplication produces a plausible figure rather than an error.
    expect(() => commissionFilsFor(MAX_COMMISSION_BASIS_FILS + 1, 10_000, 'floor')).toThrow(
      /stops being an exact integer/,
    )
    // The control, at the bound: it answers, and it answers exactly.
    expect(commissionFilsFor(MAX_COMMISSION_BASIS_FILS, 10_000, 'floor')).toBe(
      MAX_COMMISSION_BASIS_FILS,
    )
    expect(Number.isSafeInteger(MAX_COMMISSION_BASIS_FILS * 10_000)).toBe(true)
  })
})

describe('commissionBasisFilsFor — net is DERIVED, never recomputed', () => {
  it('takes the gross for a gross-inclusive version and gross - vat for a net one', () => {
    expect(commissionBasisFilsFor({ grossFils: 26_250, vatFils: 1_250 }, 'gross_inclusive')).toBe(
      26_250,
    )
    expect(commissionBasisFilsFor({ grossFils: 26_250, vatFils: 1_250 }, 'net_of_vat')).toBe(25_000)
  })

  it('refuses VAT above the gross, which is a negative net', () => {
    expect(() =>
      commissionBasisFilsFor({ grossFils: 1_000, vatFils: 1_001 }, 'net_of_vat'),
    ).toThrow(/cannot carry/)
    // The control: a zero-rated supply is VAT of 0 on a real gross, and it is fine.
    expect(commissionBasisFilsFor({ grossFils: 1_000, vatFils: 0 }, 'net_of_vat')).toBe(1_000)
  })
})

describe('commissionBandFor — the band is the greatest threshold at or below the basis', () => {
  it('picks band 1 below the second threshold and band 2 at it', () => {
    expect(commissionBandFor(TIERED, 19_999).bandNo).toBe(1)
    // AT the threshold, because `from_fils` is the INCLUSIVE lower bound. A band chosen with `>` instead
    // would put exactly-20,000 in band 1, which is a different rule from the one published.
    expect(commissionBandFor(TIERED, 20_000).bandNo).toBe(2)
    expect(commissionBandFor(TIERED, 20_001).bandNo).toBe(2)
    // Zero falls in band 1, which is what ZY073's "band 1 starts at 0" is for.
    expect(commissionBandFor(TIERED, 0).bandNo).toBe(1)
  })

  it('does not depend on the order the bands arrive in', () => {
    const shuffled: CommissionRuleVersion = {
      ...TIERED,
      bands: [...TIERED.bands].reverse(),
    }
    expect(commissionBandFor(shuffled, 25_000).rateBp).toBe(1_200)
  })
})

describe('assertCommissionRuleVersion — the version refuses to be unusable', () => {
  const withBands = (bands: CommissionRuleVersion['bands']): CommissionRuleVersion => ({
    ...FLAT_TEN_PERCENT,
    bands,
  })

  it('accepts the two fixture versions, which is the control for every refusal below', () => {
    expect(() => assertCommissionRuleVersion(FLAT_TEN_PERCENT)).not.toThrow()
    expect(() => assertCommissionRuleVersion(TIERED)).not.toThrow()
  })

  it('refuses a version with no bands, because that is not a zero-rate policy', () => {
    expect(() => assertCommissionRuleVersion(withBands([]))).toThrow(/has no bands/)
  })

  it('refuses a lowest band above zero, which would leave the cheapest treatments unpaid', () => {
    expect(() =>
      assertCommissionRuleVersion(withBands([{ bandNo: 1, fromFils: 5_000, rateBp: 1_000 }])),
    ).toThrow(/must start at 0/)
  })

  it('refuses thresholds that do not ascend with the band number', () => {
    expect(() =>
      assertCommissionRuleVersion(
        withBands([
          { bandNo: 1, fromFils: 0, rateBp: 500 },
          { bandNo: 2, fromFils: 30_000, rateBp: 1_200 },
          { bandNo: 3, fromFils: 20_000, rateBp: 1_500 },
        ]),
      ),
    ).toThrow(/not above band 2/)
  })

  it('refuses a gap in the band numbering and a rate outside 0..10000', () => {
    expect(() =>
      assertCommissionRuleVersion(
        withBands([
          { bandNo: 1, fromFils: 0, rateBp: 500 },
          { bandNo: 3, fromFils: 20_000, rateBp: 1_200 },
        ]),
      ),
    ).toThrow(/gap in its band numbers/)
    expect(() =>
      assertCommissionRuleVersion(withBands([{ bandNo: 1, fromFils: 0, rateBp: 10_001 }])),
    ).toThrow(/outside 0\.\.10000/)
  })
})

describe('commissionRuleFor — the version that governed a date, whatever is in force now', () => {
  const versions = [TIERED, FLAT_TEN_PERCENT]

  it('picks the latest version effective at or before the date, in any input order', () => {
    expect(commissionRuleFor(versions, localDate('2081-03-31')).version).toBe(1)
    expect(commissionRuleFor([...versions].reverse(), localDate('2081-03-31')).version).toBe(1)
    expect(commissionRuleFor(versions, localDate('2081-06-01')).version).toBe(2)
  })

  it('still returns version 1 for a March date after version 2 has superseded it', () => {
    // The whole subject, in one assertion: version 2 exists, is newer, and does not govern March. A
    // recompute of March that reached for "the current rules" would restate a period already paid.
    expect(commissionRuleFor(versions, localDate('2081-03-14')).ruleVersionId).toBe(
      'fixture-version-1',
    )
  })

  it('throws for a date no version governs, rather than defaulting to a rate', () => {
    expect(() => commissionRuleFor(versions, localDate('2080-12-31'))).toThrow(
      /No commission rule version is effective/,
    )
    // And for the state the database actually ships in: no version at all.
    expect(() => commissionRuleFor([], localDate('2081-03-14'))).toThrow(/no commission structure/)
  })
})

describe('computeCommission — the lines, the total, and the stated order', () => {
  const days: readonly LocalDate[] = [
    localDate('2081-03-20'),
    localDate('2081-03-02'),
    localDate('2081-03-02'),
  ]

  const threeEarnings: readonly CommissionEarning[] = [
    earning({ appointmentId: 'c-third', tradingDate: days[0] as LocalDate }),
    earning({ appointmentId: 'b-second', tradingDate: days[1] as LocalDate }),
    earning({ appointmentId: 'a-first', tradingDate: days[2] as LocalDate }),
  ]

  it('prices each earning under the version and totals them', () => {
    const computed = computeCommission({ ruleVersion: FLAT_TEN_PERCENT, earnings: threeEarnings })
    // Net of 26,250 gross less 1,250 VAT is 25,000; 10% of that is 2,500, three times.
    expect(computed.lines.map((line) => line.basisFils)).toEqual([25_000, 25_000, 25_000])
    expect(computed.lines.map((line) => line.commissionFils)).toEqual([2_500, 2_500, 2_500])
    expect(computed.totalFils).toBe(7_500)
    expect(computed.ruleVersionId).toBe('fixture-version-1')
  })

  it('orders by trading date then appointment id, whatever order the earnings arrive in', () => {
    const forwards = computeCommission({ ruleVersion: FLAT_TEN_PERCENT, earnings: threeEarnings })
    const backwards = computeCommission({
      ruleVersion: FLAT_TEN_PERCENT,
      earnings: [...threeEarnings].reverse(),
    })
    expect(forwards.lines.map((line) => line.appointmentId)).toEqual([
      'a-first',
      'b-second',
      'c-third',
    ])
    // Byte-identical is a claim about a SEQUENCE, so the two permutations have to agree as sequences.
    expect(JSON.stringify(backwards.lines)).toBe(JSON.stringify(forwards.lines))
  })

  it('commissions a package redemption on its recognised value, not on any sale value', () => {
    // A three-session course sold for 60,000 gross recognises 20,000 per visit. The line is about the
    // 20,000 that was recognised; the 60,000 is the sale and is not this appointment's value.
    const computed = computeCommission({
      ruleVersion: FLAT_TEN_PERCENT,
      earnings: [
        earning({
          appointmentId: 'redeemed-1',
          source: 'package_redemption',
          invoiceId: null,
          packageRedemptionId: 'redemption-1',
          grossFils: 20_000,
          vatFils: 952,
        }),
      ],
    })
    const [line] = computed.lines
    expect(line?.basisFils).toBe(19_048)
    // 10% of 19,048 is 1,904.8, floored to 1,904.
    expect(line?.commissionFils).toBe(1_904)
    expect(line?.source).toBe('package_redemption')
    expect(line?.packageRedemptionId).toBe('redemption-1')
    expect(line?.invoiceId).toBeNull()
  })

  it('puts a basis in the band it falls in, under the tiered version', () => {
    const computed = computeCommission({
      ruleVersion: TIERED,
      earnings: [
        earning({ appointmentId: 'small', grossFils: 15_000, vatFils: 714 }),
        earning({ appointmentId: 'large', grossFils: 26_250, vatFils: 1_250 }),
      ],
    })
    // Gross-inclusive: 15,000 is band 1 at 5%, which is 750. 26,250 is band 2 at 12%, which is 3,150.
    expect(computed.lines.map((line) => [line.bandNo, line.commissionFils])).toEqual([
      [2, 3_150],
      [1, 750],
    ])
    expect(computed.totalFils).toBe(3_900)
  })

  it('is empty and zero for a period with no earnings', () => {
    const computed = computeCommission({ ruleVersion: FLAT_TEN_PERCENT, earnings: [] })
    expect(computed.lines).toEqual([])
    expect(computed.totalFils).toBe(0)
  })

  it('refuses one appointment appearing twice rather than commissioning it twice', () => {
    expect(() =>
      computeCommission({
        ruleVersion: FLAT_TEN_PERCENT,
        earnings: [earning({ appointmentId: 'same' }), earning({ appointmentId: 'same' })],
      }),
    ).toThrow(/appears twice/)
  })
})

describe('planCommissionRun — off and nothing-to-apply are different answers', () => {
  it('reports module_disabled when the flag is off, even with a version published', () => {
    const plan = planCommissionRun({
      moduleEnabled: false,
      versions: [FLAT_TEN_PERCENT],
      periodStartsOn: localDate('2081-03-01'),
    })
    expect(plan).toEqual({
      moduleEnabled: false,
      ruleVersion: null,
      inertReason: 'module_disabled',
    })
  })

  it('reports no_rule_version when the flag is on and nothing is published', () => {
    const plan = planCommissionRun({
      moduleEnabled: true,
      versions: [],
      periodStartsOn: localDate('2081-03-01'),
    })
    expect(plan.inertReason).toBe('no_rule_version')
    expect(plan.ruleVersion).toBeNull()
    // The two reasons are distinguishable, which is the whole point: one is a settings change and the
    // other is a migration, and a screen showing the wrong one sends an operator to the wrong place.
    expect(plan.moduleEnabled).toBe(true)
  })

  it('returns the governing version when the flag is on and one is published', () => {
    const plan = planCommissionRun({
      moduleEnabled: true,
      versions: [FLAT_TEN_PERCENT, TIERED],
      periodStartsOn: localDate('2081-03-01'),
    })
    expect(plan.inertReason).toBeNull()
    expect(plan.ruleVersion?.version).toBe(1)
  })
})

describe('who may read whose derivation', () => {
  const VIEWER = 'employee-viewer'
  const OTHER = 'employee-other'

  it('lets a therapist read their own and refuses a colleague', () => {
    expect(
      mayReadCommissionDerivation({
        role: 'therapist',
        viewerEmployeeId: VIEWER,
        subjectEmployeeId: VIEWER,
      }),
    ).toBe(true)
    expect(
      mayReadCommissionDerivation({
        role: 'therapist',
        viewerEmployeeId: VIEWER,
        subjectEmployeeId: OTHER,
      }),
    ).toBe(false)
    expect(() =>
      assertMayReadCommissionDerivation({
        role: 'therapist',
        viewerEmployeeId: VIEWER,
        subjectEmployeeId: OTHER,
      }),
    ).toThrow(/only their own/)
  })

  it('lets the owner and the accountant read anybody, because they hold payroll:read', () => {
    for (const role of ['owner', 'accountant'] as const) {
      expect(
        mayReadCommissionDerivation({
          role,
          viewerEmployeeId: VIEWER,
          subjectEmployeeId: OTHER,
        }),
        role,
      ).toBe(true)
    }
  })

  it('holds a manager to their own, because the matrix withholds pay from the floor manager', () => {
    // `manager` holds `commission:read` and NOT `payroll:read`, and `ROLE_DEFINITIONS` says why in so
    // many words: "Pay is different and stays with the owner and the accountant." A commission IS pay,
    // so the wider view follows `payroll:read` rather than a role list this file would have to keep in
    // step with the matrix.
    expect(
      mayReadCommissionDerivation({
        role: 'manager',
        viewerEmployeeId: VIEWER,
        subjectEmployeeId: OTHER,
      }),
    ).toBe(false)
    expect(
      mayReadCommissionDerivation({
        role: 'manager',
        viewerEmployeeId: VIEWER,
        subjectEmployeeId: VIEWER,
      }),
    ).toBe(true)
  })

  it('refuses a role holding no commission:read at all, even for their own id', () => {
    for (const role of ['receptionist', 'marketer', 'auditor'] as const) {
      expect(
        mayReadCommissionDerivation({
          role,
          viewerEmployeeId: VIEWER,
          subjectEmployeeId: VIEWER,
        }),
        role,
      ).toBe(false)
    }
    expect(() =>
      assertMayReadCommissionDerivation({
        role: 'receptionist',
        viewerEmployeeId: VIEWER,
        subjectEmployeeId: VIEWER,
      }),
    ).toThrow(/may not read commission at all/)
  })
})

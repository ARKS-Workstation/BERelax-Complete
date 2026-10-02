import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { TENDER_KINDS } from '../checkout/posting.ts'
import { BASIS_POINTS } from '../seo/query-rows.ts'
import type {
  ContributionMarginInput,
  CostComponent,
  NetPriceSource,
} from './contribution-margin.ts'
import {
  CONTRIBUTION_MARGIN_UNIT_FORMULA,
  COST_COMPONENT_NOTES,
  COST_COMPONENT_OPEN_QUESTIONS,
  COST_COMPONENTS,
  contributionMarginUnit,
  measuredCost,
  noCostByConstruction,
  PROCESSOR_CLEARING_ACCOUNTS,
  paymentFeeComponent,
  SERVICE_CONTRIBUTION_MARGIN_FORMULA,
  serviceContributionMargin,
  tenderClearsThroughAProcessor,
  unattributableCost,
} from './contribution-margin.ts'
import type { DiscountedInvoiceLine, NoShowAppointment, PeriodFigures } from './operational-kpis.ts'
import {
  assertKpiDefinitions,
  averageTicket,
  breakEvenRevenue,
  contributionMarginRatio,
  discountLeakage,
  divideHalfUp,
  KPI_DEFINITION_RULES,
  kpiDefinitionFindings,
  labourCostPercent,
  labourCostPercentIfTipsWereIncluded,
  noShowCost,
  OPERATIONAL_KPI_DEFINITIONS,
  OPERATIONAL_KPI_IDS,
  rebookingRate,
  retailAttachment,
  shareInBasisPoints,
  WHOLE_IN_BASIS_POINTS,
} from './operational-kpis.ts'

/**
 * R-REP-04 — contribution margin per service and the operational KPI set.
 *
 * # What this file is arranged to prove, and why that is not the obvious thing
 *
 * The acceptance line is one subtraction, so a test that computes it and compares is nearly content-free.
 * What the unit is actually about is the three states a cost can be in, and in particular that **an
 * unknown cost is not a zero** — because a zero is the single most dangerous value here: it produces the
 * HIGHEST possible margin, on the screen somebody prices from, and it is indistinguishable from a cost
 * that was genuinely nil.
 *
 * So the margin cases come in pairs. Each hand-computed figure is asserted, and then the same fixture
 * with one component left UNSTATED or marked `unattributable` is asserted to produce no figure at all —
 * which is what makes the first assertion a statement about attribution rather than about arithmetic.
 *
 * The Asian and the Arabic variant are two separate fixtures with different durations and different
 * component figures, as the acceptance line asks, and their expected margins are written out as literal
 * fils with the subtraction shown in a comment. A computed expectation would be the implementation again.
 *
 * # The vacuity controls
 *
 * Every rule in `KPI_DEFINITION_RULES` is handed a definition that DOES break it, because a rule that
 * stops matching reports no findings and "the shipped definitions are fit to register" then passes over
 * definitions that have stopped being (ADR 0003). And `labourCostPercentIfTipsWereIncluded` names the
 * WRONG number for the tips assertion, so "the figure is 2,500 bp" is a claim about tips being excluded
 * rather than a second copy of the right arithmetic.
 */

// --- the two hand-computed fixtures --------------------------------------------------------------

const invoiceSource = (invoiceId: string, lineNo: number): NetPriceSource => ({
  basis: 'invoice_line',
  invoiceId,
  lineNo,
})

/**
 * Every component measured, with the figures stated here and nowhere else.
 *
 * These are FIXTURE figures and no part of them is a claim about this business: nothing in the build
 * holds a consumable cost, a room cost or a per-treatment labour cost, which is the whole subject of
 * ADR 0070. They exist so the subtraction can be exercised, exactly as P-HR-11's suite publishes a
 * fixture commission rule rather than seeding one.
 */
const measuredCosts = (figures: {
  therapist: bigint
  consumables: bigint
  roomConsumables: bigint
  paymentFee: bigint | 'none'
}): readonly CostComponent[] => [
  measuredCost(
    'therapist',
    figures.therapist,
    'fixture: commission line plus attributed wage minutes',
  ),
  measuredCost('consumables', figures.consumables, 'fixture: stated bill of materials'),
  measuredCost('room_consumables', figures.roomConsumables, 'fixture: stated room usage'),
  figures.paymentFee === 'none'
    ? noCostByConstruction('payment_fee', 'cash tender: there is no acquirer to charge a fee')
    : measuredCost('payment_fee', figures.paymentFee, 'fixture: stated merchant service charge'),
]

/** A 60-minute Asian variant sold at the till for 21,000 fils gross, 20,000 net. */
const ASIAN: ContributionMarginInput = {
  appointmentId: 'appt-asian-60',
  serviceVariantId: 'variant-asian-60',
  treatmentStyle: 'asian',
  netPriceFils: 20_000n,
  source: invoiceSource('inv-1001', 1),
  costs: measuredCosts({
    therapist: 6_000n,
    consumables: 1_250n,
    roomConsumables: 400n,
    paymentFee: 525n,
  }),
}

/** 20,000 - (6,000 + 1,250 + 400 + 525) = 11,825 */
const ASIAN_MARGIN_FILS = 11_825n

/** A 90-minute Arabic variant taken out of a package, so the price is the redemption's own snapshot. */
const ARABIC: ContributionMarginInput = {
  appointmentId: 'appt-arabic-90',
  serviceVariantId: 'variant-arabic-90',
  treatmentStyle: 'arabic',
  netPriceFils: 28_571n,
  source: { basis: 'package_redemption', redemptionId: 'redemption-77' },
  costs: measuredCosts({
    therapist: 9_000n,
    consumables: 2_100n,
    roomConsumables: 600n,
    paymentFee: 'none',
  }),
}

/** 28,571 - (9,000 + 2,100 + 600 + 0) = 16,871 */
const ARABIC_MARGIN_FILS = 16_871n

describe('contribution margin per delivery', () => {
  it('is net price minus every stated cost, to the fils, for an Asian and an Arabic variant', () => {
    const asian = contributionMarginUnit(ASIAN)
    const arabic = contributionMarginUnit(ARABIC)

    expect(asian.state).toBe('margin')
    expect(arabic.state).toBe('margin')
    if (asian.state !== 'margin' || arabic.state !== 'margin') return

    expect(asian.marginFils).toBe(ASIAN_MARGIN_FILS)
    expect(asian.costFils).toBe(8_175n)
    expect(asian.netPriceFils).toBe(20_000n)
    expect(arabic.marginFils).toBe(ARABIC_MARGIN_FILS)
    expect(arabic.costFils).toBe(11_700n)

    // The two really are different fixtures, so the pair is not one assertion written twice.
    expect(asian.marginFils).not.toBe(arabic.marginFils)
    expect(asian.treatmentStyle).not.toBe(arabic.treatmentStyle)
  })

  it('names the row its net price came from, and has nowhere to put a catalogue price', () => {
    const asian = contributionMarginUnit(ASIAN)
    const arabic = contributionMarginUnit(ARABIC)
    expect(asian.netPriceBasis).toBe('invoice_line inv-1001#1')
    // The acceptance line's package case: the figure is the redemption's snapshot, named as such.
    expect(arabic.netPriceBasis).toBe('package_redemption redemption-77')
  })

  it('a component left out of the cost list is refused rather than summed as zero', () => {
    const withoutConsumables = {
      ...ASIAN,
      costs: ASIAN.costs.filter((cost) => cost.component !== 'consumables'),
    }
    expect(() => contributionMarginUnit(withoutConsumables)).toThrow(/absent consumables/)
    // The control: had it been summed as zero, the margin would have been LARGER by the cost.
    expect(ASIAN_MARGIN_FILS + 1_250n).toBe(13_075n)
  })

  it('a component stated twice is refused, because nobody knows which figure was meant', () => {
    const twice = {
      ...ASIAN,
      costs: [...ASIAN.costs, measuredCost('consumables', 99n, 'fixture: a second opinion')],
    }
    expect(() => contributionMarginUnit(twice)).toThrow(/repeated consumables/)
  })

  it('an unattributable component makes the margin not_attributable, never a larger margin', () => {
    const unknownTherapistCost = {
      ...ASIAN,
      costs: ASIAN.costs.map((cost) =>
        cost.component === 'therapist'
          ? unattributableCost(
              'therapist',
              'no commission rule is published and basic_wage_fils is null for all nineteen',
            )
          : cost,
      ),
    }
    const result = contributionMarginUnit(unknownTherapistCost)
    expect(result.state).toBe('not_attributable')
    if (result.state !== 'not_attributable') return
    expect(result.missing).toEqual(['therapist'])
    expect(result.openQuestionIds).toEqual(['Y8-staff', 'Y9-commission', 'Y9-unit-cost-basis'])
    // The figure that WOULD have been reported had the unknown been read as zero, named so the
    // assertion above is about attribution rather than about a missing property.
    expect(result.netPriceFils - result.attributedCostFils).toBe(17_825n)
    expect(result).not.toHaveProperty('marginFils')
  })

  it('a cost of zero by construction is a figure, and is not the same state as an unknown', () => {
    const arabic = contributionMarginUnit(ARABIC)
    if (arabic.state !== 'margin') throw new Error('the Arabic fixture must produce a margin')
    const fee = arabic.components.find((component) => component.component === 'payment_fee')
    expect(fee?.state).toBe('none_by_construction')
    // A card tender measured at zero would be an acquirer that charged nothing: the same number,
    // a different claim, and only one of them survives somebody signing an agreement.
    const measuredZero = measuredCost(
      'payment_fee',
      0n,
      'fixture: an acquirer that charged nothing',
    )
    expect(measuredZero.state).toBe('measured')
    expect(measuredZero.state).not.toBe(fee?.state)
  })

  it('refuses a negative cost, which is what makes margin <= net price a property', () => {
    expect(() => measuredCost('consumables', -1n, 'a rebate')).toThrow(/is negative/)
  })

  it('refuses a cost with no stated basis, and an unattributable one that names no question', () => {
    expect(() => measuredCost('consumables', 1n, '   ')).toThrow(/must say what it was taken from/)
    expect(() => unattributableCost('consumables', 'unknown', [])).toThrow(
      /must name the open question/,
    )
  })

  it('states a note and at least one open question for every component', () => {
    for (const component of COST_COMPONENTS) {
      expect(COST_COMPONENT_NOTES[component].trim().length).toBeGreaterThan(20)
      expect(COST_COMPONENT_OPEN_QUESTIONS[component].length).toBeGreaterThan(0)
    }
    expect(COST_COMPONENTS).toEqual(['therapist', 'consumables', 'room_consumables', 'payment_fee'])
    expect(CONTRIBUTION_MARGIN_UNIT_FORMULA).toContain('not_attributable')
  })
})

describe('the payment-fee component', () => {
  it('is zero by construction for money received in hand and unknown for a processed tender', () => {
    expect(paymentFeeComponent(['cash'])).toMatchObject({ state: 'none_by_construction' })
    expect(paymentFeeComponent(['bank_transfer'])).toMatchObject({
      state: 'none_by_construction',
    })
    expect(paymentFeeComponent(['card_in_salon'])).toMatchObject({
      state: 'unattributable',
      openQuestionIds: ['Y7-card-fee'],
    })
    expect(paymentFeeComponent(['card_online'])).toMatchObject({ state: 'unattributable' })
    // No tender at all is a redemption: the money arrived with the package sale, and so did any fee.
    expect(paymentFeeComponent([])).toMatchObject({ state: 'none_by_construction' })
  })

  it('a split tender with one processed leg is unknown for the whole delivery', () => {
    const mixed = paymentFeeComponent(['cash', 'card_in_salon'])
    expect(mixed.state).toBe('unattributable')
    if (mixed.state !== 'unattributable') return
    // Reporting the cash leg's zero would be a fee of zero on the whole document.
    expect(mixed.basis).toContain('card_in_salon')
    expect(mixed.basis).not.toContain('cash,')
  })

  it('classifies every tender kind in the registry, by where the registry says it posts', () => {
    // A tender kind added to TENDER_KINDS is classified by construction rather than by somebody
    // remembering to extend a list here — which is what makes the two assertions above complete.
    const processed = TENDER_KINDS.filter(tenderClearsThroughAProcessor)
    expect(processed).toEqual(['card_in_salon', 'card_online'])
    expect([...PROCESSOR_CLEARING_ACCOUNTS].sort()).toEqual(['1030', '1040'])
    for (const kind of TENDER_KINDS) {
      const component = paymentFeeComponent([kind])
      expect(['none_by_construction', 'unattributable'], `${kind} is unclassified`).toContain(
        component.state,
      )
    }
  })
})

describe('contribution margin per service over a period', () => {
  it('a service with no delivery in the period is no_data, never zero', () => {
    const result = serviceContributionMargin({
      serviceVariantId: 'variant-asian-60',
      periodId: '2027-03',
      units: [],
    })
    expect(result.state).toBe('no_data')
    if (result.state !== 'no_data') return
    expect(result.why).toContain('different facts')
    expect(result).not.toHaveProperty('marginFils')
  })

  it('sums the deliveries, and one unattributable unit makes the whole period not_attributable', () => {
    const sound = serviceContributionMargin({
      serviceVariantId: 'variant-asian-60',
      periodId: '2027-03',
      units: [ASIAN, { ...ASIAN, appointmentId: 'appt-asian-60-b' }],
    })
    expect(sound.state).toBe('margin')
    if (sound.state !== 'margin') return
    expect(sound.deliveries).toBe(2)
    expect(sound.marginFils).toBe(ASIAN_MARGIN_FILS * 2n)

    const mixed = serviceContributionMargin({
      serviceVariantId: 'variant-asian-60',
      periodId: '2027-03',
      units: [
        ASIAN,
        {
          ...ASIAN,
          appointmentId: 'appt-asian-60-c',
          costs: ASIAN.costs.map((cost) =>
            cost.component === 'consumables'
              ? unattributableCost('consumables', 'no per-treatment usage is recorded')
              : cost,
          ),
        },
      ],
    })
    expect(mixed.state).toBe('not_attributable')
    if (mixed.state !== 'not_attributable') return
    expect(mixed.missing).toEqual(['consumables'])
    // A margin over the attributable subset would have a denominator that moves with how much happens
    // to be known. The figure it would have reported is named so the refusal is visible as a choice.
    expect(mixed.netRevenueFils).toBe(40_000n)
    expect(SERVICE_CONTRIBUTION_MARGIN_FORMULA).toContain('no_data')
  })

  it('property: no margin exceeds its net revenue, over generated cost sets that can disagree', () => {
    let couldDisagree = 0
    let total = 0
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            netPriceFils: fc.bigInt({ min: 0n, max: 10_000_000n }),
            therapist: fc.bigInt({ min: 0n, max: 4_000_000n }),
            consumables: fc.bigInt({ min: 0n, max: 4_000_000n }),
            roomConsumables: fc.bigInt({ min: 0n, max: 4_000_000n }),
            paymentFee: fc.bigInt({ min: 0n, max: 4_000_000n }),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        (rows) => {
          total += 1
          // The claim is an INEQUALITY, so a generated set of all-zero costs cannot exercise it: the
          // margin equals the net revenue and every implementation agrees. Count the sets that can
          // (brief rule 22) and assert the count against a measured floor below.
          if (
            rows.some(
              (row) => row.therapist + row.consumables + row.roomConsumables + row.paymentFee > 0n,
            )
          ) {
            couldDisagree += 1
          }
          const result = serviceContributionMargin({
            serviceVariantId: 'variant-generated',
            periodId: '2027-03',
            units: rows.map((row, index) => ({
              appointmentId: `appt-${index}`,
              serviceVariantId: 'variant-generated',
              treatmentStyle: 'asian',
              netPriceFils: row.netPriceFils,
              source: invoiceSource('inv-generated', index + 1),
              costs: measuredCosts({
                therapist: row.therapist,
                consumables: row.consumables,
                roomConsumables: row.roomConsumables,
                paymentFee: row.paymentFee,
              }),
            })),
          })
          if (result.state !== 'margin') return false
          return result.marginFils <= result.netRevenueFils
        },
      ),
      { numRuns: 400 },
    )
    // Measured on this generator, not guessed: with four independent costs each uniform over a wide
    // range, a set in which every cost is zero is vanishingly rare, and the observed count over
    // repeated runs was 400 of 400. The floor is set well under that so it is not its own flake.
    expect(total).toBeGreaterThanOrEqual(400)
    expect(couldDisagree).toBeGreaterThanOrEqual(380)
  }, 30_000)
})

// --- the rounding rule ---------------------------------------------------------------------------

describe('the one rounding rule', () => {
  it('rounds half-up AWAY from zero, in both directions', () => {
    expect(divideHalfUp(5n, 2n)).toBe(3n)
    expect(divideHalfUp(-5n, 2n)).toBe(-3n)
    expect(divideHalfUp(4n, 2n)).toBe(2n)
    expect(divideHalfUp(1n, 3n)).toBe(0n)
    expect(divideHalfUp(2n, 3n)).toBe(1n)
    // The control: bigint division truncates, which is the silent bias this exists to remove.
    expect(5n / 2n).toBe(2n)
    expect(-5n / 2n).toBe(-2n)
  })

  it('refuses a zero denominator rather than answering one', () => {
    expect(() => divideHalfUp(1n, 0n)).toThrow(/no_denominator/)
    expect(() => divideHalfUp(1n, -2n)).toThrow(/no_denominator/)
  })

  it('agrees with the one statement of "a whole is 10,000 basis points" in this package', () => {
    // The check that holds a second statement of a fact equal to the first, in the same commit. The
    // bigint path cannot import the number, so this is what stops the two drifting.
    expect(Number(WHOLE_IN_BASIS_POINTS)).toBe(BASIS_POINTS)
  })

  it('states a share in whole basis points', () => {
    expect(shareInBasisPoints(1n, 3n)).toBe(3333)
    expect(shareInBasisPoints(1n, 1n)).toBe(10_000)
    expect(shareInBasisPoints(0n, 7n)).toBe(0)
  })
})

// --- the operational KPIs ------------------------------------------------------------------------

describe('average ticket', () => {
  it('divides invoice net by invoices issued and reports credit notes beside it', () => {
    const result = averageTicket({
      invoiceNetFils: 300_001n,
      invoiceCount: 4,
      creditNoteNetFils: 50_000n,
    })
    expect(result.state).toBe('value')
    if (result.state !== 'value') return
    // 300,001 / 4 = 75,000.25 -> 75,000
    expect(result.value.averageNetFils).toBe(75_000n)
    expect(result.value.creditNoteNetFils).toBe(50_000n)
    // The control: netting the credit note in would have given 62,500 over a denominator counting
    // tickets the credit note is not one of.
    expect(divideHalfUp(300_001n - 50_000n, 4n)).toBe(62_500n)
  })

  it('a period with no invoice is no_denominator, never zero', () => {
    const result = averageTicket({ invoiceNetFils: 0n, invoiceCount: 0, creditNoteNetFils: 0n })
    expect(result.state).toBe('no_denominator')
  })
})

describe('retail attachment', () => {
  it('is a share of tickets, and refuses counts taken over different populations', () => {
    const result = retailAttachment({ invoiceCount: 8, invoicesCarryingRetail: 1 })
    expect(result.state).toBe('value')
    if (result.state !== 'value') return
    expect(result.value).toBe(1_250)
    expect(() => retailAttachment({ invoiceCount: 2, invoicesCarryingRetail: 3 })).toThrow(
      /more than all of them/,
    )
  })
})

describe('rebooking rate', () => {
  it('requires a window and has no default for it', () => {
    expect(() =>
      rebookingRate({ deliveredAppointments: 10, rebookedWithinWindow: 3, windowDays: 0 }),
    ).toThrow(/required argument with no default/)
    const result = rebookingRate({
      deliveredAppointments: 10,
      rebookedWithinWindow: 3,
      windowDays: 30,
    })
    expect(result.state).toBe('value')
    if (result.state !== 'value') return
    expect(result.value.rateBp).toBe(3_000)
    // The window travels WITH the figure, so two tiles cannot show the same rate over different windows.
    expect(result.value.windowDays).toBe(30)
  })

  it('a period with no delivery is no_denominator, never a zero rate', () => {
    const result = rebookingRate({
      deliveredAppointments: 0,
      rebookedWithinWindow: 0,
      windowDays: 30,
    })
    expect(result.state).toBe('no_denominator')
  })
})

describe('no-show cost', () => {
  const noShows: readonly NoShowAppointment[] = [
    {
      appointmentId: 'appt-ns-1',
      businessDay: '2027-03-04',
      netFils: 20_000n,
      roomMinutes: 80,
    },
    {
      appointmentId: 'appt-ns-2',
      businessDay: '2027-03-04',
      netFils: 28_571n,
      roomMinutes: 110,
    },
  ]

  it('sums the snapshotted net, drills to the rows, and reports room minutes separately', () => {
    const result = noShowCost(noShows)
    expect(result.state).toBe('value')
    if (result.state !== 'value') return
    expect(result.value.costFils).toBe(48_571n)
    expect(result.value.lostRoomMinutes).toBe(190)
    expect(result.value.appointmentIds).toEqual(['appt-ns-1', 'appt-ns-2'])
    // Lost room time is NOT money: it is reported alongside, and pricing it here would double-count
    // the price the no-show already carries.
    expect(result.value).not.toHaveProperty('lostRoomFils')
  })

  it('a period with no no-show is a measured zero, which is a fact and a good one', () => {
    const result = noShowCost([])
    expect(result.state).toBe('value')
    if (result.state !== 'value') return
    expect(result.value.costFils).toBe(0n)
    expect(result.value.noShows).toBe(0)
  })

  it('refuses a negative snapshot, which would reduce the cost of the other no-shows', () => {
    expect(() => noShowCost([{ ...(noShows[0] as NoShowAppointment), netFils: -1n }])).toThrow(
      /carries a net of -1 fils/,
    )
  })
})

describe('discount leakage', () => {
  const lines: readonly DiscountedInvoiceLine[] = [
    { invoiceId: 'inv-1001', lineNo: 1, chargedGrossFils: 19_000n, listGrossFils: 21_000n },
    { invoiceId: 'inv-1001', lineNo: 2, chargedGrossFils: 31_500n, listGrossFils: 31_500n },
    { invoiceId: 'inv-1002', lineNo: 1, chargedGrossFils: 10_000n, listGrossFils: 10_500n },
  ]

  it('is the sum of (list gross - charged gross) and drills to the lines it came off', () => {
    const result = discountLeakage(lines)
    expect(result.state).toBe('value')
    if (result.state !== 'value') return
    // (21,000 - 19,000) + (31,500 - 31,500) + (10,500 - 10,000) = 2,500
    expect(result.value.leakageGrossFils).toBe(2_500n)
    expect(result.value.lines).toBe(3)
    expect(result.value.discountedLines).toBe(2)
    expect(result.value.drillsTo).toEqual([
      { invoiceId: 'inv-1001', lineNo: 1 },
      { invoiceId: 'inv-1002', lineNo: 1 },
    ])
  })

  it('a line with no snapshotted list gross makes the figure not_attributable, not smaller', () => {
    const result = discountLeakage([
      ...lines,
      { invoiceId: 'inv-1003', lineNo: 1, chargedGrossFils: 5_000n, listGrossFils: null },
    ])
    expect(result.state).toBe('not_attributable')
    if (result.state !== 'not_attributable') return
    expect(result.missing).toEqual(['list_gross_fils'])
    expect(result.why).toContain('inv-1003#1')
    // The control: contributing zero for that line would have reported the same 2,500 as a complete
    // figure over a population one line larger.
    expect(discountLeakage(lines)).toMatchObject({ value: { leakageGrossFils: 2_500n } })
  })

  it('refuses a line charged above its list price, which is a surcharge and not leakage', () => {
    expect(() =>
      discountLeakage([
        { invoiceId: 'inv-1004', lineNo: 1, chargedGrossFils: 100n, listGrossFils: 90n },
      ]),
    ).toThrow(/surcharge, not a discount/)
  })
})

describe('labour cost %', () => {
  const labour = {
    wagesFils: 400_000n,
    commissionFils: 80_000n,
    gratuityAccrualFils: 15_000n,
    leaveAccrualFils: 5_000n,
  }

  it('uses net revenue as its denominator and excludes tips from its numerator', () => {
    const withTips = labourCostPercent({
      labour,
      netRevenueFils: 2_000_000n,
      tipsCollectedFils: 120_000n,
    })
    const withoutTips = labourCostPercent({
      labour,
      netRevenueFils: 2_000_000n,
      tipsCollectedFils: 0n,
    })
    expect(withTips.state).toBe('value')
    expect(withoutTips.state).toBe('value')
    if (withTips.state !== 'value' || withoutTips.state !== 'value') return

    // 500,000 / 2,000,000 = 25%
    expect(withTips.value.percentBp).toBe(2_500)
    expect(withTips.value.labourCostFils).toBe(500_000n)
    // The fixture CONTAINS tips and the figure is unchanged by them, which is the acceptance line.
    expect(withTips.value.percentBp).toBe(withoutTips.value.percentBp)
    // And they were excluded rather than absent: the figure carries them.
    expect(withTips.value.tipsCollectedFils).toBe(120_000n)

    // The wrong method, named. Without this the assertion above would be satisfied by a fixture whose
    // tips happened to be zero, or by two copies of the same arithmetic.
    expect(
      labourCostPercentIfTipsWereIncluded({
        labour,
        netRevenueFils: 2_000_000n,
        tipsCollectedFils: 120_000n,
      }),
    ).toBe(3_100)
  })

  it('a period with no net revenue is no_denominator, never an infinite ratio', () => {
    const result = labourCostPercent({ labour, netRevenueFils: 0n, tipsCollectedFils: 0n })
    expect(result.state).toBe('no_denominator')
  })
})

describe('contribution margin ratio and break-even', () => {
  it('are no_data while nothing classifies the expense accounts as fixed or variable', () => {
    const ratio = contributionMarginRatio({
      netRevenueFils: 2_000_000n,
      variableCostFils: null,
    })
    expect(ratio.state).toBe('no_data')
    if (ratio.state !== 'no_data') return
    expect(ratio.missingFigures).toEqual(['variableCostFils'])
    expect(ratio.why).toContain('largest possible answer')

    const breakEven = breakEvenRevenue({
      fixedCostFils: null,
      contributionMarginRatioBp: null,
    })
    expect(breakEven.state).toBe('no_data')
    if (breakEven.state !== 'no_data') return
    expect(breakEven.missingFigures).toEqual(['fixedCostFils', 'contributionMarginRatioBp'])
  })

  it('compute to the fils once both figures are supplied', () => {
    const ratio = contributionMarginRatio({
      netRevenueFils: 2_000_000n,
      variableCostFils: 700_000n,
    })
    expect(ratio.state).toBe('value')
    if (ratio.state !== 'value') return
    // (2,000,000 - 700,000) / 2,000,000 = 65%
    expect(ratio.value).toBe(6_500)

    const breakEven = breakEvenRevenue({
      fixedCostFils: 650_000n,
      contributionMarginRatioBp: ratio.value,
    })
    expect(breakEven.state).toBe('value')
    if (breakEven.state !== 'value') return
    // 650,000 / 0.65 = 1,000,000
    expect(breakEven.value).toBe(1_000_000n)
  })

  it('a ratio that covers no fixed cost at any volume is a finding, not a number', () => {
    const result = breakEvenRevenue({ fixedCostFils: 650_000n, contributionMarginRatioBp: 0 })
    expect(result.state).toBe('no_denominator')
    if (result.state !== 'no_denominator') return
    expect(result.why).toContain('no revenue at which this business breaks even')
  })
})

// --- the registrable set -------------------------------------------------------------------------

describe('the operational KPI definitions', () => {
  it('states one definition per id, keyed on its own id, with a formula and a grain', () => {
    expect(Object.keys(OPERATIONAL_KPI_DEFINITIONS).sort()).toEqual([...OPERATIONAL_KPI_IDS].sort())
    expect(kpiDefinitionFindings()).toEqual([])
    expect(() => assertKpiDefinitions()).not.toThrow()
    for (const kpiId of OPERATIONAL_KPI_IDS) {
      const definition = OPERATIONAL_KPI_DEFINITIONS[kpiId]
      expect(definition.kpiId).toBe(kpiId)
      expect(definition.formula.length).toBeGreaterThan(40)
      expect(definition.figures.length).toBeGreaterThan(0)
    }
  })

  it('every definition rule is shown to be able to fail', () => {
    const broken: Record<(typeof KPI_DEFINITION_RULES)[number], () => unknown> = {
      'kpi-definition-key-matches-its-own-id': () => ({
        ...OPERATIONAL_KPI_DEFINITIONS,
        average_ticket: { ...OPERATIONAL_KPI_DEFINITIONS.average_ticket, kpiId: 'rebooking_rate' },
      }),
      'kpi-definition-carries-a-non-empty-formula': () => ({
        ...OPERATIONAL_KPI_DEFINITIONS,
        average_ticket: { ...OPERATIONAL_KPI_DEFINITIONS.average_ticket, formula: '  ' },
      }),
      'kpi-definition-states-its-grain': () => ({
        ...OPERATIONAL_KPI_DEFINITIONS,
        average_ticket: { ...OPERATIONAL_KPI_DEFINITIONS.average_ticket, grain: '' },
      }),
      'kpi-definition-names-the-figures-it-reads': () => ({
        ...OPERATIONAL_KPI_DEFINITIONS,
        average_ticket: { ...OPERATIONAL_KPI_DEFINITIONS.average_ticket, figures: [] },
      }),
      'kpi-definition-formula-names-its-own-unit': () => ({
        ...OPERATIONAL_KPI_DEFINITIONS,
        average_ticket: {
          ...OPERATIONAL_KPI_DEFINITIONS.average_ticket,
          formula: 'the average of the things, divided by the other things',
        },
      }),
    }
    for (const rule of KPI_DEFINITION_RULES) {
      const definitions = broken[rule]() as typeof OPERATIONAL_KPI_DEFINITIONS
      const findings = kpiDefinitionFindings(definitions)
      expect(
        findings.map((finding) => finding.rule),
        `rule ${rule} reported no finding`,
      ).toContain(rule)
    }
  })

  it('a null figure makes a KPI no_data naming the figure, and never zero', () => {
    const nothingRead: PeriodFigures = {
      periodId: '2027-03',
      invoiceNetFils: null,
      invoiceCount: null,
      creditNoteNetFils: null,
      invoicesCarryingRetail: null,
      deliveredAppointments: null,
      rebookedWithinWindow: null,
      rebookingWindowDays: null,
      noShows: null,
      discountedLines: null,
      labour: null,
      netRevenueFils: null,
      tipsCollectedFils: null,
      variableCostFils: null,
      fixedCostFils: null,
    }
    for (const kpiId of OPERATIONAL_KPI_IDS) {
      const outcome = OPERATIONAL_KPI_DEFINITIONS[kpiId].compute(nothingRead)
      expect(outcome.state, `${kpiId} answered ${outcome.state} over a bag of nulls`).toBe(
        'no_data',
      )
      if (outcome.state !== 'no_data') continue
      expect(outcome.missingFigures.length, `${kpiId} named no missing figure`).toBeGreaterThan(0)
    }
  })

  it('computes through the registrable definitions, not only through the typed functions', () => {
    const figures: PeriodFigures = {
      periodId: '2027-03',
      invoiceNetFils: 300_001n,
      invoiceCount: 4,
      creditNoteNetFils: 50_000n,
      invoicesCarryingRetail: 0,
      deliveredAppointments: 10,
      rebookedWithinWindow: 3,
      rebookingWindowDays: 30,
      noShows: [],
      discountedLines: [],
      labour: {
        wagesFils: 400_000n,
        commissionFils: 80_000n,
        gratuityAccrualFils: 15_000n,
        leaveAccrualFils: 5_000n,
      },
      netRevenueFils: 2_000_000n,
      tipsCollectedFils: 120_000n,
      variableCostFils: null,
      fixedCostFils: 650_000n,
    }
    expect(OPERATIONAL_KPI_DEFINITIONS.average_ticket.compute(figures)).toMatchObject({
      value: { averageNetFils: 75_000n },
    })
    expect(OPERATIONAL_KPI_DEFINITIONS.labour_cost_percent.compute(figures)).toMatchObject({
      value: { percentBp: 2_500 },
    })
    expect(OPERATIONAL_KPI_DEFINITIONS.retail_attachment_rate.compute(figures)).toMatchObject({
      value: 0,
    })
    // Still no_data, because the fixed/variable split is what is missing and not the fixed cost.
    expect(OPERATIONAL_KPI_DEFINITIONS.break_even_revenue.compute(figures)).toMatchObject({
      state: 'no_data',
    })
  })
})

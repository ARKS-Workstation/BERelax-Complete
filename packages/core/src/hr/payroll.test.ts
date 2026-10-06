import { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { localDate } from '../time.ts'
import type { AttendanceVariance } from './attendance.ts'
import { forecastLabourCost, type LabourCostRules } from './labour-cost.ts'
import {
  assertAttendanceIsComplete,
  assertCommissionIsPinned,
  assertMayReadPayslip,
  computePayslip,
  incompletePresencesOf,
  mayReadPayslip,
  overtimeUpliftMinuteBp,
  PAYSLIP_EARNING_COMPONENTS,
  type Payslip,
  priceOvertimeUplift,
  summarisePayroll,
} from './payroll.ts'

/**
 * P-HR-12 — the payslip's arithmetic, its pins, and every refusal that stops a wrong one being produced.
 *
 * ## The oracle, and why it is a third implementation rather than a second
 *
 * The acceptance criterion asks that the arithmetic be "asserted against an independent oracle". There are
 * three statements of the identity in this build and this file holds the third:
 *
 *   1. `summarisePayroll` sums the components in TypeScript;
 *   2. `payslip.gross_fils` and `payslip.net_fils` are GENERATED columns that sum them again in SQL
 *      (migration 0104), which `packages/fixtures/src/hr-payroll.itest.ts` compares against the first;
 *   3. {@link oracle} below, which is written from the acceptance line's own words and shares no code with
 *      either.
 *
 * Three matters because two would not be enough: if the oracle were `summarisePayroll` called differently it
 * would agree with itself, and if it were the SQL it would need a database. The oracle here is deliberately
 * naive — a loop and six additions — because the thing it is checking is that the production code has not
 * become clever.
 *
 * ## The control every claim carries
 *
 * Brief rule 3: each assertion is paired with one that must fail. So the wrong figure is looked for and must
 * NOT be found, the vacuity of each generator is measured, and the refusals are asserted to fire with the
 * specific message that names the cause — not merely to throw.
 */

/** A rule set the TESTS own. No figure here is a claim about this business (Y9-overtime is unanswered). */
const RULES: LabourCostRules = {
  effectiveFrom: localDate('2026-01-01'),
  monthlyWageDaysDivisor: 30,
  paidMinutesPerDay: 480,
}

/**
 * The identity, written from the acceptance criterion and from nothing in `payroll.ts`.
 *
 * `basic + allowances + overtime + commission + tips − deductions = net`. Six additions and a subtraction,
 * spelled out rather than folded into a reduce over `PAYSLIP_EARNING_COMPONENTS`, because reusing that list
 * would make this the same computation as the one it is checking.
 */
function oracle(p: {
  basic: number
  allowances: number
  overtime: number
  commission: number
  tips: number
  deductions: number
}): { gross: number; net: number } {
  const gross = p.basic + p.allowances + p.overtime + p.commission + p.tips
  return { gross, net: gross - p.deductions }
}

/** A payslip built through the production path, from the oracle's own inputs. */
function payslipFrom(
  employeeId: string,
  p: {
    basic: number
    allowances: number
    overtime: number
    commission: number
    tips: number
    deductions: number
  },
): Payslip {
  return computePayslip({
    employeeId,
    basicWageFils: p.basic,
    allowancesFils: p.allowances,
    overtimeFils: p.overtime,
    commission:
      p.commission === 0
        ? { fils: 0, runId: null, ruleVersion: null }
        : { fils: p.commission, runId: `run-${employeeId}`, ruleVersion: 1 },
    tipsFils: p.tips,
    deductionsFils: p.deductions,
  })
}

/**
 * Worked examples, chosen for what each one would catch rather than for coverage.
 *
 * The figures are fixtures. `600000` fils is 6,000 AED and is a plausible monthly wage for a therapist in
 * this market — which is exactly why it must be said here and not in a migration: it is a number this test
 * needs, not a wage anybody has agreed (Y8-staff).
 */
const WORKED = [
  {
    what: 'an ordinary month: no overtime, no commission, no tips, no deductions',
    employeeId: 'e-ordinary',
    figures: {
      basic: 600_000,
      allowances: 150_000,
      overtime: 0,
      commission: 0,
      tips: 0,
      deductions: 0,
    },
    expect: { gross: 750_000, net: 750_000 },
  },
  {
    what: 'every component present, so no term can be dropped without the total moving',
    employeeId: 'e-full',
    figures: {
      basic: 600_000,
      allowances: 150_000,
      overtime: 12_500,
      commission: 4_375,
      tips: 3_000,
      deductions: 20_000,
    },
    expect: { gross: 769_875, net: 749_875 },
  },
  {
    what: 'a deduction that takes the net to exactly zero, which is the boundary and not a refusal',
    employeeId: 'e-zero-net',
    figures: { basic: 1, allowances: 0, overtime: 0, commission: 0, tips: 0, deductions: 1 },
    expect: { gross: 1, net: 0 },
  },
  {
    what: 'a single fil in each component, where any dropped term is visible',
    employeeId: 'e-fils',
    figures: { basic: 1, allowances: 1, overtime: 1, commission: 1, tips: 1, deductions: 1 },
    expect: { gross: 5, net: 4 },
  },
] as const

describe('the payslip identity, against an independent oracle', () => {
  it.each(WORKED)('$what', ({ employeeId, figures, expect: stated }) => {
    const payslip = payslipFrom(employeeId, figures)
    const computed = oracle(figures)

    // The three agree: the production path, the naive oracle, and the figures written out by hand above.
    expect(payslip.grossFils).toBe(computed.gross)
    expect(payslip.netFils).toBe(computed.net)
    expect(payslip.grossFils).toBe(stated.gross)
    expect(payslip.netFils).toBe(stated.net)

    // The control. A net one fil out is looked for and must not be found — the assertion above would pass
    // for a payslip that was wrong by a fil in both the production path and the oracle only if they shared
    // the mistake, which the hand-written expectation is what rules out.
    expect(payslip.netFils).not.toBe(stated.net + 1)
    expect(payslip.netFils).not.toBe(stated.net - 1)
  })

  it('reconciles in total as well as per employee', () => {
    const payslips = WORKED.map((row) => payslipFrom(row.employeeId, row.figures))
    const summary = summarisePayroll(payslips)

    const expectedNet = WORKED.reduce((sum, row) => sum + oracle(row.figures).net, 0)
    expect(summary.netTotalFils).toBe(expectedNet)
    expect(summary.payslipCount).toBe(WORKED.length)
    // Component totals, each against the oracle's own sum of that component.
    expect(summary.componentTotalsFils.basic).toBe(
      WORKED.reduce((sum, row) => sum + row.figures.basic, 0),
    )
    expect(summary.componentTotalsFils.tips).toBe(
      WORKED.reduce((sum, row) => sum + row.figures.tips, 0),
    )
    // Vacuity floor: a suite over one payslip, or over payslips with no tips, would satisfy the lines above
    // while saying nothing about summation.
    expect(payslips.length).toBeGreaterThanOrEqual(4)
    expect(summary.componentTotalsFils.tips).toBeGreaterThan(0)
  })

  it('refuses a run whose per-payslip components do not sum to its gross', () => {
    // The CONTROL for the identity: a payslip whose gross disagrees with its lines must be caught. It cannot
    // be built through `computePayslip`, which is the point — so it is constructed directly, which is what a
    // restore with triggers off or a hand-written row would produce.
    const broken: Payslip = { ...payslipFrom('e-full', WORKED[1].figures), grossFils: 1 }
    expect(() => summarisePayroll([broken])).toThrow(/components sum to/)
  })

  it('refuses a run whose net does not follow from its gross and deductions', () => {
    const broken: Payslip = { ...payslipFrom('e-full', WORKED[1].figures), netFils: 999 }
    expect(() => summarisePayroll([broken])).toThrow(/is not .* gross less/)
  })

  it('refuses two payslips for one employee in one run', () => {
    const one = payslipFrom('e-twice', WORKED[0].figures)
    expect(() => summarisePayroll([one, one])).toThrow(/two payslips in one run/)
  })

  it('catches two payslips whose errors CANCEL, which a total-only check would pass', () => {
    /*
      The case the second assertion in `summarisePayroll` exists for, and the reason it is not redundant with
      the per-payslip one: a figure moved from one employee's line to another's leaves the run total exactly
      right. Here 5,000 fils of overtime is taken off one payslip and added to the other, so the net total is
      unchanged and both payslips are individually wrong.
    */
    const a = { ...payslipFrom('e-a', WORKED[1].figures), overtimeFils: 7_500 }
    const b = { ...payslipFrom('e-b', WORKED[1].figures), overtimeFils: 17_500 }
    const totalUnchanged = a.overtimeFils + b.overtimeFils === WORKED[1].figures.overtime * 2
    expect(
      totalUnchanged,
      'the fixture must keep the run total identical, or it proves nothing',
    ).toBe(true)
    expect(() => summarisePayroll([a, b])).toThrow(/components sum to/)
  })
})

describe('the overtime uplift is the excess over the ordinary rate, never the whole of it', () => {
  it('is zero for a month with no uplift minutes, which is what proves the subtraction happened', () => {
    // 480 minutes a day for 22 days, every minute ordinary at 10,000 bp.
    const payableMinutes = 480 * 22
    const uplift = overtimeUpliftMinuteBp({
      payableMinutes,
      weightedMinuteBp: payableMinutes * 10_000,
      ordinaryMultiplierBp: 10_000,
    })
    expect(uplift).toBe(0)
    expect(
      priceOvertimeUplift({ basicWageFils: 600_000, upliftMinuteBp: uplift, rules: RULES }),
    ).toBe(0)
  })

  it('prices only the excess when some minutes carry an uplift', () => {
    // 10,560 ordinary minutes plus 120 minutes of overtime at 12,500 bp.
    const payableMinutes = 480 * 22 + 120
    const weightedMinuteBp = 480 * 22 * 10_000 + 120 * 12_500
    const uplift = overtimeUpliftMinuteBp({
      payableMinutes,
      weightedMinuteBp,
      ordinaryMultiplierBp: 10_000,
    })
    // 120 minutes × (12,500 − 10,000) = 300,000 basis-point-minutes.
    expect(uplift).toBe(300_000)

    const fils = priceOvertimeUplift({
      basicWageFils: 600_000,
      upliftMinuteBp: uplift,
      rules: RULES,
    })
    // 600,000 × 300,000 ÷ (30 × 480 × 10,000) = 1,250 fils, exactly.
    expect(fils).toBe(1_250)

    // The control that matters most in this unit: pricing the WHOLE weighted total instead of the uplift is
    // the double-payment defect, and it is an order of magnitude out rather than subtly wrong.
    const whole = priceOvertimeUplift({
      basicWageFils: 600_000,
      upliftMinuteBp: weightedMinuteBp,
      rules: RULES,
    })
    expect(whole).toBeGreaterThan(fils * 100)
  })

  it('reads the ordinary multiplier from the version rather than assuming 10,000', () => {
    /*
      The reason `ordinaryMultiplierBp` is an argument. `working_hours_rule` pins it at 10,000 today, so a
      literal would agree with the table and keep agreeing after a version changed it — silently overpaying,
      with every figure on the page still reconciling. Here the same figures are measured against 12,000 and
      the uplift is smaller, which a constant could not produce.
    */
    const payableMinutes = 100
    const weightedMinuteBp = 100 * 12_500
    expect(
      overtimeUpliftMinuteBp({ payableMinutes, weightedMinuteBp, ordinaryMultiplierBp: 10_000 }),
    ).toBe(250_000)
    expect(
      overtimeUpliftMinuteBp({ payableMinutes, weightedMinuteBp, ordinaryMultiplierBp: 12_000 }),
    ).toBe(50_000)
  })

  it('refuses a weighted total below the ordinary-rate total rather than clamping it to zero', () => {
    // Impossible through any approval this build can write (0059's CHECK), and answered rather than clamped:
    // clamping would pay the monthly wage and drop real overtime without saying so.
    expect(() =>
      overtimeUpliftMinuteBp({
        payableMinutes: 100,
        weightedMinuteBp: 100 * 9_000,
        ordinaryMultiplierBp: 10_000,
      }),
    ).toThrow(/is not clamped to zero/)
  })

  it('uses the SAME formula as the labour-cost forecast, so the two cannot round differently', () => {
    /*
      `filsForWeightedMinuteBp` has two callers — the roster forecast and this payslip — and the whole reason
      it is shared is that a second spelling would make them disagree by a fil, and the difference would be
      read as the rostered-versus-attended variance rather than as two implementations parting company.

      Asserted by driving the forecast over one day whose weighted total equals an uplift figure, and
      comparing. A test that called the primitive twice would prove nothing; this calls it through both
      public functions.
    */
    const weightedMinuteBp = 7_777
    const viaPayslip = priceOvertimeUplift({
      basicWageFils: 613_333,
      upliftMinuteBp: weightedMinuteBp,
      rules: RULES,
    })
    const viaForecast = forecastLabourCost({
      days: [
        {
          employeeId: 'e-1',
          tradingDate: localDate('2026-03-02'),
          totalMinutes: 1,
          minutes: { ordinary: 1, overtime: 0, night: 0, publicHoliday: 0 },
          multiplierBp: {
            ordinary: 10_000,
            overtime: 12_500,
            night: 15_000,
            publicHoliday: 15_000,
          },
          weightedMinuteBp,
          overtimeMinutes: 0,
          overtimeBeyondCapMinutes: 0,
          isPublicHoliday: false,
          shiftIds: [],
        },
      ],
      wages: [{ employeeId: 'e-1', basicWageFils: 613_333 }],
      ruleVersions: [RULES],
    })
    expect(viaForecast.totalFils).toBe(viaPayslip)
    // Vacuity: a figure that rounded to nothing would satisfy the equality trivially.
    expect(viaPayslip).toBeGreaterThan(0)
  })
})

describe('a payslip refuses to be produced rather than producing a wrong one', () => {
  it('refuses an employee with no wage on file instead of paying zero', () => {
    expect(() =>
      computePayslip({
        employeeId: 'e-unpriced',
        basicWageFils: null,
        allowancesFils: 0,
        overtimeFils: 0,
        commission: { fils: 0, runId: null, ruleVersion: null },
        tipsFils: 0,
        deductionsFils: 0,
      }),
    ).toThrow(/no basic wage on file/)
  })

  it('refuses deductions above gross rather than flooring the net at zero', () => {
    expect(() =>
      payslipFrom('e-over', {
        basic: 100,
        allowances: 0,
        overtime: 0,
        commission: 0,
        tips: 0,
        deductions: 101,
      }),
    ).toThrow(/exceed gross pay/)
  })

  it('refuses a negative or fractional component by name', () => {
    for (const [field, figures] of [
      [
        'An allowance total',
        { basic: 1, allowances: -1, overtime: 0, commission: 0, tips: 0, deductions: 0 },
      ],
      [
        'A tip total',
        { basic: 1, allowances: 0, overtime: 0, commission: 0, tips: 0.5, deductions: 0 },
      ],
      [
        'An overtime figure',
        { basic: 1, allowances: 0, overtime: -2, commission: 0, tips: 0, deductions: 0 },
      ],
    ] as const) {
      let thrown: unknown
      try {
        payslipFrom('e-bad', figures)
      } catch (error) {
        thrown = error
      }
      expect(thrown, `${field} was accepted`).toBeInstanceOf(AppError)
      expect((thrown as AppError).message).toContain(field)
    }
  })
})

describe('the commission pin: a figure that cannot be reproduced is refused', () => {
  it('refuses a non-zero commission that names no run', () => {
    expect(() => assertCommissionIsPinned({ fils: 1_250, runId: null, ruleVersion: null })).toThrow(
      /names no run/,
    )
    expect(() => assertCommissionIsPinned({ fils: 1_250, runId: 'r1', ruleVersion: null })).toThrow(
      /names no run/,
    )
  })

  it('refuses a ZERO commission that names a run, because that claims a run was read', () => {
    // Not pedantry: "a run produced nothing for this employee" and "the module is disabled" are the same
    // zero and different facts, and `commission_run.module_enabled` exists because the second must never be
    // reported as "no commission is due".
    expect(() => assertCommissionIsPinned({ fils: 0, runId: 'r1', ruleVersion: 1 })).toThrow(
      /zero commission names a run/i,
    )
  })

  it('accepts the two shapes that are honest, and nothing between them', () => {
    expect(() =>
      assertCommissionIsPinned({ fils: 0, runId: null, ruleVersion: null }),
    ).not.toThrow()
    expect(() => assertCommissionIsPinned({ fils: 9, runId: 'r1', ruleVersion: 3 })).not.toThrow()
    expect(() => assertCommissionIsPinned({ fils: 9, runId: 'r1', ruleVersion: 0 })).toThrow(
      /not a version/,
    )
  })

  it('carries the pin through to the payslip, so the version is ON the document', () => {
    const payslip = payslipFrom('e-full', WORKED[1].figures)
    expect(payslip.commissionRunId).toBe('run-e-full')
    expect(payslip.commissionRuleVersion).toBe(1)
    // And a zero-commission payslip carries neither, which is what ZY147 requires of the row.
    const plain = payslipFrom('e-ordinary', WORKED[0].figures)
    expect(plain.commissionRunId).toBeNull()
    expect(plain.commissionRuleVersion).toBeNull()
  })
})

describe('an INCOMPLETE attendance row stops the run and is named', () => {
  const sheet = {
    timesheetApprovalId: 'ta-1',
    employeeId: 'e-1',
    fromTradingDate: localDate('2026-03-01'),
    toTradingDate: localDate('2026-03-31'),
    payableMinutes: 0,
    weightedMinuteBp: 0,
    incompletePresenceCount: 2,
    workingHoursRuleEffectiveFrom: localDate('2026-01-01'),
  }

  it('passes over a period whose approvals count none', () => {
    expect(() =>
      assertAttendanceIsComplete({
        timesheets: [{ ...sheet, incompletePresenceCount: 0 }],
        incomplete: [],
      }),
    ).not.toThrow()
  })

  it('refuses on the stored count alone, naming the approval', () => {
    expect(() => assertAttendanceIsComplete({ timesheets: [sheet], incomplete: [] })).toThrow(
      /timesheet_approval ta-1/,
    )
  })

  it('names the specific punches when the caller has them', () => {
    let thrown: unknown
    try {
      assertAttendanceIsComplete({
        timesheets: [sheet],
        incomplete: [
          {
            employeeId: 'e-1',
            tradingDate: localDate('2026-03-04'),
            clockInEventId: 'ae-77',
            reason: 'missing_clock_out',
          },
        ],
      })
    } catch (error) {
      thrown = error
    }
    expect((thrown as AppError).message).toContain('attendance_event ae-77')
    expect((thrown as AppError).message).toContain('missing_clock_out')
    expect((thrown as AppError).details['incompleteEventIds']).toEqual(['ae-77'])
  })

  it('reads the punch ids off P-HR-07 variances rather than judging them again', () => {
    const variances: AttendanceVariance[] = [
      {
        employeeId: 'e-1',
        tradingDate: localDate('2026-03-04'),
        outcome: 'INCOMPLETE',
        incompleteReason: 'implausible_span',
        lateByMinutes: 0,
        earlyLeaveByMinutes: 0,
        rosteredMinutes: 480,
        attendedMinutes: 0,
        presences: [
          {
            employeeId: 'e-1',
            tradingDate: localDate('2026-03-04'),
            startsAt: 0 as never,
            endsAt: null,
            clockInEventId: 'ae-91',
            clockOutEventId: null,
          },
        ],
      },
      {
        employeeId: 'e-1',
        tradingDate: localDate('2026-03-05'),
        outcome: 'ON_TIME',
        incompleteReason: null,
        lateByMinutes: 0,
        earlyLeaveByMinutes: 0,
        rosteredMinutes: 480,
        attendedMinutes: 480,
        presences: [],
      },
    ]
    const refs = incompletePresencesOf(variances)
    // Only the INCOMPLETE one, and with its reason carried rather than re-derived.
    expect(refs).toEqual([
      {
        employeeId: 'e-1',
        tradingDate: '2026-03-04',
        clockInEventId: 'ae-91',
        reason: 'implausible_span',
      },
    ])
    // The control: the ON_TIME row must not contribute, and a projection that returned everything would.
    expect(refs).toHaveLength(1)
  })
})

describe('who may read a payslip', () => {
  const own = { viewerEmployeeId: 'e-1', subjectEmployeeId: 'e-1' }
  const other = { viewerEmployeeId: 'e-1', subjectEmployeeId: 'e-2' }

  it('lets the owner and the accountant read anybody', () => {
    for (const role of ['owner', 'accountant'] as const) {
      expect(mayReadPayslip({ role, ...own })).toBe(true)
      expect(mayReadPayslip({ role, ...other })).toBe(true)
    }
  })

  it('lets a therapist and a manager read their OWN and refuses a colleague', () => {
    // The manager is the case worth spelling out: they hold `employee:read` and not `payroll:read`, which is
    // ROLE_DEFINITIONS' "Pay is different" — a floor manager runs the rota and does not see what the floor
    // is paid.
    for (const role of ['therapist', 'manager'] as const) {
      expect(mayReadPayslip({ role, ...own })).toBe(true)
      expect(mayReadPayslip({ role, ...other })).toBe(false)
    }
  })

  it('refuses a receptionist and a marketer outright', () => {
    for (const role of ['receptionist', 'marketer'] as const) {
      expect(mayReadPayslip({ role, ...own })).toBe(false)
      expect(mayReadPayslip({ role, ...other })).toBe(false)
    }
  })

  it('refuses BEFORE the read, with a message that distinguishes the two refusals', () => {
    expect(() => assertMayReadPayslip({ role: 'receptionist', ...own })).toThrow(
      /may not read a payslip at all/,
    )
    expect(() => assertMayReadPayslip({ role: 'therapist', ...other })).toThrow(
      /only their own payslip/,
    )
    expect(() => assertMayReadPayslip({ role: 'owner' as const, ...other })).not.toThrow()
  })
})

describe('the component list is the document', () => {
  it('names the five components the acceptance criterion does, in order', () => {
    expect(PAYSLIP_EARNING_COMPONENTS).toEqual([
      'basic',
      'allowances',
      'overtime',
      'commission',
      'tips',
    ])
  })
})

import { describe, expect, it } from 'vitest'
import {
  type PayrollPageView,
  type PayrollRunView,
  type PayslipLineView,
  renderPayrollHtml,
} from '../app/(admin)/hr/payroll/render.ts'

/**
 * The payroll screen's document, from a view.
 *
 * Pure: a view in, bytes out. The claims worth making here are the ones about what a PERSON reads, because
 * every other layer of this unit is asserted against rows — and "no WPS file can be produced yet, and here
 * is why" is a claim about a rendered sentence and nothing else.
 *
 * Every figure in this file is this file's own fixture, not the build's assumption: `Y8-staff` records that
 * all nineteen real employees have no wage on file, and `Y8-wps` that no employer identifier has ever been
 * supplied.
 *
 * `packages/fixtures/src/hr-payroll.itest.ts` makes the halves this cannot: that the figures come out of
 * real rows, that a read writes an audit row, and that a colleague's payslip is a refusal.
 */

const CHROME: PayrollPageView['chrome'] = {
  googleReauth: null,
  sendBacklog: null,
  role: 'owner' as const,
  returnTo: '/hr/payroll',
}

const RUN: PayrollRunView = {
  runId: '11111111-1111-1111-1111-111111111111',
  periodStartsOn: '2079-03-01',
  periodEndsOn: '2079-03-31',
  payslipCount: 2,
  netTotalFils: 1_500_000,
  unpricedEmployeeCount: 3,
  completedAtIso: '2079-04-02T06:00:00.000Z',
  completedBy: 'HR administrator',
  correctsRunId: null,
  labourCostRuleEffectiveFrom: '1900-01-01',
}

const PAYSLIP: PayslipLineView = {
  staffReference: 'Therapist 07',
  basicFils: 600_000,
  allowancesFils: 155_000,
  overtimeFils: 12_375,
  commissionFils: 0,
  tipsFils: 3_125,
  grossFils: 770_500,
  deductionsFils: 18_400,
  netFils: 752_100,
  payableMinutes: 10_680,
  commissionRunId: null,
  commissionRuleVersion: null,
  timesheetApprovalId: '22222222-2222-2222-2222-222222222222',
  workingHoursRuleEffectiveFrom: '1900-01-01',
}

function view(over: Partial<PayrollPageView> = {}): PayrollPageView {
  return {
    chrome: CHROME,
    readAtIso: '2079-04-02T07:30:00.000Z',
    periodStartsOn: '2079-03-01',
    periodEndsOn: '2079-03-31',
    runs: [RUN],
    payslips: [PAYSLIP],
    subject: { staffReference: 'Therapist 07', ownOnly: false },
    exports: [],
    wps: {
      employerIdConfigured: false,
      agentIdConfigured: false,
      openQuestionId: 'Y8-wps',
    },
    accountingPeriod: { closed: false, periodId: null, earliestOpenDate: '2079-03-31' },
    ...over,
  }
}

describe('the screen says why no WPS file can be produced, rather than showing nothing', () => {
  it('names both unset identifiers and the open question', () => {
    const html = renderPayrollHtml(view())
    expect(html).toContain('No WPS file can be produced yet')
    expect(html).toContain('employer identifier')
    expect(html).toContain('agent identifier')
    expect(html).toContain('Y8-wps')
    // The reason, not just the fact: this sentence is the one that stops somebody "fixing" it by typing a
    // number that looks right.
    expect(html).toContain('another employer’s registration')
  })

  it('names only the one that is unset when the other is configured', () => {
    const html = renderPayrollHtml(
      view({
        wps: { employerIdConfigured: true, agentIdConfigured: false, openQuestionId: 'Y8-wps' },
      }),
    )
    expect(html).toContain('No WPS file can be produced yet')
    expect(html).toContain('agent identifier')
    // The control: a screen that always printed both would say "employer identifier" here too.
    expect(html).not.toContain('employer identifier')
  })

  it('says something different, and true, once both are set', () => {
    const html = renderPayrollHtml(
      view({
        wps: { employerIdConfigured: true, agentIdConfigured: true, openQuestionId: 'Y8-wps' },
      }),
    )
    expect(html).not.toContain('No WPS file can be produced yet')
    expect(html).toContain('The WPS identifiers are set')
    // Still true, and still worth saying: there is no submission path in this software.
    expect(html).toContain('no submission path')
  })
})

describe('an empty period is not reported as "nobody is owed anything"', () => {
  it('says nobody has RUN payroll, which is a different fact', () => {
    const html = renderPayrollHtml(view({ runs: [], payslips: [] }))
    expect(html).toContain('nobody has run payroll')
    // The control: the words that would be wrong.
    expect(html).not.toContain('No payroll is due')
  })

  it('counts the employees with no wage on file beside the run', () => {
    // 0081's argument, and it bites harder here: a run that treated an absent wage as zero would pay
    // nineteen payslips of 0.00 AED and every figure on the screen would reconcile.
    expect(renderPayrollHtml(view())).toContain('3 employee(s) had no wage on file')
    const none = renderPayrollHtml(view({ runs: [{ ...RUN, unpricedEmployeeCount: 0 }] }))
    expect(none).not.toContain('had no wage on file')
  })
})

describe('a completed run says it is final, and a draft says it has paid nobody', () => {
  it('prints the correction rule beside a completed run', () => {
    const html = renderPayrollHtml(view())
    expect(html).toContain('Completed')
    expect(html).toContain('a NEW dated run naming this one')
  })

  it('prints the draft state, which no WPS file may be taken of', () => {
    const html = renderPayrollHtml(
      view({ runs: [{ ...RUN, completedAtIso: null, completedBy: null }] }),
    )
    expect(html).toContain('DRAFT')
    expect(html).toContain('no WPS file may be taken of it')
    // The control: a draft must not claim the immutability a completed run has.
    expect(html).not.toContain('It is now immutable')
  })

  it('names the run a correction corrects', () => {
    const html = renderPayrollHtml(
      view({ runs: [{ ...RUN, correctsRunId: '33333333-3333-3333-3333-333333333333' }] }),
    )
    expect(html).toContain('Corrects run')
    expect(html).toContain('33333333-3333-3333-3333-333333333333')
  })
})

describe('every payslip figure is printed, and each names what produced it', () => {
  it('prints all five components, the gross, the deductions and the net', () => {
    const html = renderPayrollHtml(view())
    for (const [what, fils] of [
      ['basic', 600_000],
      ['allowances', 155_000],
      ['overtime', 12_375],
      ['tips', 3_125],
      ['gross', 770_500],
      ['deductions', 18_400],
      ['net', 752_100],
    ] as const) {
      const dirhams = Math.trunc(fils / 100).toLocaleString('en-GB')
      expect(html, `${what} is missing`).toContain(
        `AED ${dirhams}.${String(fils % 100).padStart(2, '0')}`,
      )
    }
    // The control: a net one fil out is not on the page.
    expect(html).not.toContain('AED 7,521.01')
  })

  it('says a tip is a liability the salon passes on, not something it earned', () => {
    // The acceptance line is that a tip is a separate line and never revenue. The column alone does not say
    // the second half, and this screen is where somebody would otherwise assume the salon earned it.
    const html = renderPayrollHtml(view())
    expect(html).toContain('never reaches a revenue account')
    expect(html).toContain('AED 31.25')
    // And with no tips, the sentence is absent rather than claiming zero tips were passed on.
    const none = renderPayrollHtml(view({ payslips: [{ ...PAYSLIP, tipsFils: 0 }] }))
    expect(none).not.toContain('never reaches a revenue account')
  })

  it('names the timesheet approval and the hours rule version under every payslip', () => {
    const html = renderPayrollHtml(view())
    expect(html).toContain('10680 payable minutes')
    expect(html).toContain('hours rule 1900-01-01')
  })

  it('says NO commission structure is configured rather than printing a blank', () => {
    const html = renderPayrollHtml(view())
    expect(html).toContain('no commission run (no structure is configured)')
    // The control: when a run IS pinned, the identifiers are printed instead of the sentence.
    const pinned = renderPayrollHtml(
      view({
        payslips: [
          {
            ...PAYSLIP,
            commissionFils: 4_250,
            commissionRunId: '44444444-4444-4444-4444-444444444444',
            commissionRuleVersion: 2,
          },
        ],
      }),
    )
    expect(pinned).toContain('44444444-4444-4444-4444-444444444444')
    expect(pinned).toContain('v2')
    expect(pinned).not.toContain('no structure is configured')
  })
})

describe('whose payslip the screen is showing', () => {
  it('tells a narrowed viewer it is their own, and why there is no way to ask for another', () => {
    const html = renderPayrollHtml(
      view({ subject: { staffReference: 'Therapist 07', ownOnly: true } }),
    )
    expect(html).toContain('only — you')
    expect(html).toContain('needs the payroll permission')
    expect(html).toContain('no way to ask for another employee')
  })

  it('tells a payroll reader that their reads are recorded', () => {
    const html = renderPayrollHtml(view())
    expect(html).toContain('every employee')
    // Reading somebody else's pay is audited, and saying so on the page is part of the control.
    expect(html).toContain('recorded with your name')
  })

  it('names no person, only the handle', () => {
    // Brief rule 10 and ADR 0020: nineteen employment records have no name, and a payslip screen is exactly
    // where an invented one would look like a fact about somebody.
    const html = renderPayrollHtml(view())
    expect(html).toContain('Therapist 07')
    expect(html).not.toMatch(/\bdisplay_name\b/)
  })
})

describe('the document itself', () => {
  it('is noindex, is not cached by a title carrying the brand, and declares its locale', () => {
    const html = renderPayrollHtml(view())
    expect(html).toContain('<meta name="robots" content="noindex, nofollow, noarchive">')
    expect(html).toContain('<title>Payroll — HR admin</title>')
    expect(html).toContain('<html lang="en" dir="ltr">')
  })

  it('lists exports with their digest, because an export is the signal that gets watched', () => {
    const html = renderPayrollHtml(
      view({
        exports: [
          {
            exportedAtIso: '2079-04-02T08:00:00.000Z',
            exportedBy: 'HR administrator',
            recordCount: 2,
            fileSha256: 'a'.repeat(64),
            format: 'generic_mohre_v1',
          },
        ],
      }),
    )
    expect(html).toContain('2 record(s)')
    expect(html).toContain('a'.repeat(64))
    expect(html).toContain('generic_mohre_v1')
    // The control: with no exports the list says so rather than rendering an empty element.
    expect(renderPayrollHtml(view())).toContain('No file has been exported')
  })

  it('escapes what it prints, so a staff reference cannot inject markup', () => {
    const html = renderPayrollHtml(
      view({ payslips: [{ ...PAYSLIP, staffReference: '<script>alert(1)</script>' }] }),
    )
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

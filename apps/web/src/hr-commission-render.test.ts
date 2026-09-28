import { describe, expect, it } from 'vitest'
import {
  type CommissionPageView,
  type CommissionRunView,
  renderCommissionHtml,
} from '../app/(admin)/hr/commission/render.ts'

/**
 * The commission screen's document, from a view.
 *
 * Pure: a view in, bytes out. The claims worth making here are the ones about what a PERSON reads, because
 * every other layer of this unit is asserted against rows — and the acceptance line "the disabled state is
 * visible in the admin UI ... no silent success" is a claim about a rendered sentence and nothing else.
 *
 * Every figure in this file is this file's own fixture, not the build's assumption: `commission_rule` seeds
 * nothing, because Y9-commission's provisional answer is that no commission structure is configured.
 *
 * `apps/web/src/hr-commission.itest.ts` makes the half this cannot: that the ROUTE hands the renderer a
 * disabled view, and that a therapist's cookie gets a narrower page than an owner's.
 */

const CHROME: CommissionPageView['chrome'] = {
  googleReauth: null,
  returnTo: '/hr/commission',
}

const run: CommissionRunView = {
  runId: '11111111-1111-1111-1111-111111111111',
  ruleVersion: 1,
  totalFils: 5_000,
  lineCount: 2,
  sourceAsOf: '2081-04-01T06:00:00.000Z',
  lockedPeriodId: null,
  moduleEnabled: true,
  computedAt: '2081-04-01T06:00:00.000Z',
}

function view(over: Partial<CommissionPageView> = {}): CommissionPageView {
  return {
    chrome: CHROME,
    readAtIso: '2081-04-02T08:00:00.000Z',
    periodStartsOn: '2081-03-01',
    periodEndsOn: '2081-03-31',
    moduleEnabled: false,
    moduleOpenQuestionId: 'Y9-commission',
    versions: [],
    runs: [],
    derivation: [],
    subject: { staffReference: 'Therapist 07', ownOnly: true },
    accountingPeriod: { closed: false, periodId: null, earliestOpenDate: '2081-03-31' },
    ...over,
  }
}

describe('the disabled state', () => {
  it('says the module is off, why, and which question is open', () => {
    const html = renderCommissionHtml(view())
    expect(html).toContain('The commission module is DISABLED')
    expect(html).toContain('Y9-commission')
    expect(html).toContain('no commission structure has been agreed')
    // The distinction the whole sentence exists for. "No commission is due" is a claim about the business;
    // "the module is off" is a claim about configuration, and an empty screen says the first by accident.
    expect(html).toContain('This is not "no commission is due"')
  })

  it('says the module is ENABLED when it is, so the banner is not a constant', () => {
    // The control. Without it the disabled assertion above would pass over a renderer that printed that
    // sentence unconditionally — which is a screen that says "disabled" after somebody turns it on.
    const html = renderCommissionHtml(view({ moduleEnabled: true }))
    expect(html).toContain('The commission module is ENABLED')
    expect(html).not.toContain('The commission module is DISABLED')
  })

  it('says no rule version is published, and why nothing is seeded', () => {
    const html = renderCommissionHtml(view())
    expect(html).toContain('No commission rule version is published')
    expect(html).toContain('rather than holding a rate this build invented')
  })
})

describe('a run says which version judged it and when its figures were read', () => {
  it('prints the version, the total, the line count and both instants', () => {
    const html = renderCommissionHtml(view({ moduleEnabled: true, runs: [run] }))
    expect(html).toContain('under rule version 1')
    expect(html).toContain('AED 50.00')
    expect(html).toContain('2 appointment(s)')
    // The instant the figures were read at, which is the field that answers "why does the recomputed March
    // differ from the March we paid". A screen that printed only `computedAt` would not.
    expect(html).toContain('source figures as at')
  })

  it('says a locked period’s figures were read AS FILED, and an open one’s were not', () => {
    const locked = renderCommissionHtml(
      view({ moduleEnabled: true, runs: [{ ...run, lockedPeriodId: '2081-03' }] }),
    )
    expect(locked).toContain('read AS FILED')
    expect(locked).toContain('cannot move this total')
    // The control, on the same renderer with one field changed: the open-period run says the opposite.
    const open = renderCommissionHtml(view({ moduleEnabled: true, runs: [run] }))
    expect(open).toContain('The period was OPEN')
    expect(open).not.toContain('read AS FILED')
  })

  it('says why there is more than one run, rather than looking like a duplicate', () => {
    const html = renderCommissionHtml(
      view({
        moduleEnabled: true,
        runs: [run, { ...run, runId: '22222222-2222-2222-2222-222222222222' }],
      }),
    )
    expect(html).toContain('a period computed again is a NEW run')
    // And with one run the sentence is absent, so it is about the plural rather than printed always.
    expect(renderCommissionHtml(view({ moduleEnabled: true, runs: [run] }))).not.toContain(
      'a period computed again is a NEW run',
    )
  })
})

describe('the derivation', () => {
  const lines = [
    {
      staffReference: 'Therapist 07',
      appointmentId: '33333333-3333-3333-3333-333333333333',
      tradingDate: '2081-03-14',
      source: 'invoice_line',
      basisFils: 25_000,
      bandNo: 1,
      rateBp: 1_000,
      commissionFils: 2_500,
    },
    {
      staffReference: 'Therapist 07',
      appointmentId: '44444444-4444-4444-4444-444444444444',
      tradingDate: '2081-03-20',
      source: 'package_redemption',
      basisFils: 25_000,
      bandNo: 1,
      rateBp: 1_000,
      commissionFils: 2_500,
    },
  ] as const

  it('prints the basis, the band, the rate and the figure for each appointment', () => {
    const html = renderCommissionHtml(
      view({ moduleEnabled: true, runs: [run], derivation: [...lines] }),
    )
    expect(html).toContain('AED 25.00')
    expect(html).toContain('10%')
    expect(html).toContain('(band 1)')
    expect(html).toContain('package_redemption')
    // The rows and the header total, together. The header is an INDEPENDENT figure held equal to the lines
    // by the database (ZY074), so printing both is what makes "they sum to the total" readable rather than a
    // sum agreeing with itself.
    expect(html).toContain('These rows')
    expect(html).toContain('Run total')
  })

  it('says whose rows are shown, and that a colleague’s cannot be asked for', () => {
    const own = renderCommissionHtml(
      view({ subject: { staffReference: 'Therapist 07', ownOnly: true } }),
    )
    expect(own).toContain('only — you')
    expect(own).toContain('There is no way to ask for another employee’s from this screen')
    const all = renderCommissionHtml(
      view({ subject: { staffReference: 'Therapist 07', ownOnly: false } }),
    )
    expect(all).toContain('Showing <strong>every employee</strong>')
    expect(all).not.toContain('only — you')
  })

  it('states the gating rule in the words the acceptance line uses', () => {
    // The screen has to say WHY an appointment is absent, because the commonest support question about a
    // commission figure is about a treatment that is not on it.
    const html = renderCommissionHtml(view({ moduleEnabled: true, runs: [run] }))
    expect(html).toContain('COMPLETED and whose document was PAID')
    expect(html).toContain('not on what the course sold for')
  })
})

describe('money and rates are formatted from integers', () => {
  it('renders fils as dirhams without a float, including the zero-padded remainder', () => {
    const html = renderCommissionHtml(
      view({
        moduleEnabled: true,
        runs: [{ ...run, totalFils: 100_005 }],
      }),
    )
    // 100,005 fils is AED 1,000.05 — and the assertion is about the PADDING, because `.5` is the shape a
    // float-formatted figure takes and it is wrong by a factor of ten.
    expect(html).toContain('AED 1,000.05')
    expect(html).not.toContain('AED 1,000.5')
  })

  it('renders a basis-point rate exactly, including a fractional percentage', () => {
    const html = renderCommissionHtml(
      view({
        moduleEnabled: true,
        versions: [
          {
            version: 1,
            effectiveFrom: '2081-01-01',
            basis: 'net_of_vat',
            roundingMode: 'floor',
            openQuestionId: 'Y9-commission',
            superseded: false,
            bands: [
              { bandNo: 1, fromFils: 0, rateBp: 1_250 },
              { bandNo: 2, fromFils: 20_000, rateBp: 1_000 },
            ],
          },
        ],
      }),
    )
    expect(html).toContain('12.5%')
    expect(html).toContain('(1250bp)')
    expect(html).toContain('10%')
  })

  it('marks a superseded version as still the one that judged its runs', () => {
    const version = {
      version: 1,
      effectiveFrom: '2081-01-01',
      basis: 'net_of_vat' as const,
      roundingMode: 'floor' as const,
      openQuestionId: null,
      bands: [{ bandNo: 1, fromFils: 0, rateBp: 1_000 }],
    }
    const html = renderCommissionHtml(
      view({
        moduleEnabled: true,
        versions: [
          { ...version, superseded: true },
          { ...version, version: 2, effectiveFrom: '2081-06-01', superseded: false },
        ],
      }),
    )
    expect(html).toContain('Version 1, effective 2081-01-01 (superseded)')
    expect(html).toContain('still the version that judged every run naming it')
    // The control: version 2 is not marked, so the marker is about the field rather than printed always.
    expect(html).toContain('Version 2, effective 2081-06-01</h3>')
  })
})

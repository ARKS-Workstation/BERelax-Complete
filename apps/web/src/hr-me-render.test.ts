import { PORTAL_BANK_MASK, portalBankView } from '@berelax/core'
import { describe, expect, it } from 'vitest'
import { renderLeaveFilingHtml } from '../app/(admin)/hr/leave/render.ts'
import {
  type PortalLeaveFormView,
  type PortalPageView,
  renderStaffPortalHtml,
} from '../app/(admin)/hr/me/render.ts'
import type { AdminChrome } from './components/admin/google-reauth-banner.ts'

/**
 * P-HR-14 — the bytes of the two screens.
 *
 * The field policy is asserted twice on purpose and the two halves catch different things.
 * `packages/core/src/hr/self-service.test.ts` asserts the SET: these five field names and nothing whose
 * sensitivity is not `open`. This asserts the DOCUMENT: that no wage, no identity figure and no account
 * number appears in the HTML, however it got there. A figure arriving through some other field — a view
 * widened by a later unit, a label carrying a number — is invisible to the first and caught by this.
 *
 * Every absence is paired with the presence that proves the walk sees anything at all: the document DOES
 * contain the staff reference, the mask and the balance, so "it contains no salary" is not satisfied by an
 * empty string.
 */

/** No banner to show, which is the ordinary state. G-CONN-08 requires the CALL, not the banner. */
const CHROME: AdminChrome = {
  googleReauth: null,
  sendBacklog: null,
  returnTo: '/hr/me',
}

const EMPTY_FORM: PortalLeaveFormView = {
  from: '',
  to: '',
  kind: 'annual',
  refusal: null,
  submitted: null,
}

function view(overrides: Partial<PortalPageView> = {}): PortalPageView {
  return {
    chrome: CHROME,
    readAtIso: '2026-09-25T10:00:00.000Z',
    readAtLabel: '25 Sep 2026, 14:00',
    staffReference: 'Therapist 07',
    employedFrom: '2024-01-01',
    employedUntil: null,
    contractType: 'full_time',
    displayName: null,
    shiftsFromLabel: '2026-09-25',
    shiftsToLabel: '2026-10-23',
    shifts: [
      { tradingDate: '2026-09-26', startsAtLabel: '11:00', endsAtLabel: '19:00', rotaVersionNo: 3 },
    ],
    leaveRequests: [
      { kind: 'annual', status: 'pending', fromLabel: '1 Oct 2026', toLabel: '3 Oct 2026' },
    ],
    leaveBalanceHundredths: 2150,
    leaveReservedHundredths: 300,
    leaveForm: EMPTY_FORM,
    leaveKinds: ['annual', 'sick', 'unpaid', 'other'],
    commission: [{ tradingDate: '2026-09-20', basisFils: 20_000, commissionFils: 1_000 }],
    commissionEnabled: true,
    payslips: [
      {
        periodStartsOn: '2026-08-01',
        periodEndsOn: '2026-08-31',
        grossFils: 500_000,
        deductionsFils: 10_000,
        netFils: 490_000,
      },
    ],
    bank: portalBankView({ onFile: true, label: 'Salary account', filedOn: '2026-03-04' }),
    ...overrides,
  }
}

describe('the staff portal document', () => {
  const html = renderStaffPortalHtml(view())

  it('is a noindex document with the two admin banners on it', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<meta name="robots" content="noindex, nofollow, noarchive">')
    // G-CONN-08 and H-HARD-05: `renderAdminBanner` emits both, and `google-reauth-banner.test.ts` walks
    // `app/(admin)` and requires the CALL in every document — this asserts the call is inside `<main>`,
    // where a landmark can hold it, which is the other half of that file's claim.
    const main = html.indexOf('<main>')
    expect(main).toBeGreaterThan(-1)
    // With no banner to show both renderers answer the empty string, so the assertion is about the
    // ORDER of the markers rather than about banner text that is legitimately absent.
    expect(html.indexOf('<h1>Your details</h1>')).toBeGreaterThan(main)
  })

  it('says on its face that it shows one person and refuses the rest', () => {
    // The sentence is the screen's half of the unit's claim. A page that silently showed only your own
    // rows would be indistinguishable from one that had been filtered, which is the distinction the
    // refusal exists to make.
    expect(html).toContain('shows your own record and nobody else')
    expect(html).toContain('refusal in the')
  })

  it('shows the staff reference and no person name, which is the presence control', () => {
    expect(html).toContain('Therapist 07')
    expect(html).toContain('data-portal-staff-reference="Therapist 07"')
    // Nineteen employees have no display name recorded, and the portal says so rather than printing
    // "unknown" where a name goes (ADR 0020).
    expect(html).toContain('none recorded')
  })

  it('shows the bank MASK and no account number', () => {
    expect(html).toContain(PORTAL_BANK_MASK)
    expect(html).toContain('data-portal-bank="masked"')
    expect(html).toContain('Salary account')
    // The claim: nothing IBAN-shaped is in the document. An IBAN is two letters, two check digits and up
    // to thirty alphanumerics; this refuses any run of eight or more digits anywhere, which also catches
    // a bare account number.
    expect(
      html,
      'portal-document-must-not-contain-an-account-number: a run of eight or more digits is in the ' +
        'document',
    ).not.toMatch(/\d{8,}/)
    expect(html).toContain('never shown on this page')
  })

  it('shows no wage figure and no identity field', () => {
    for (const forbidden of [
      'basicWage',
      'housingAllowance',
      'transportAllowance',
      'totalWage',
      'Basic wage',
      'Emirates ID',
      'passport',
      'Gender',
      'bankIban',
      'documentNumber',
    ]) {
      expect(
        html,
        `portal-document-must-not-contain-a-wage: the portal document contains ${forbidden}`,
      ).not.toContain(forbidden)
    }
    // The presence control for the loop above: the document DOES contain the money it is allowed to show,
    // so "no wage" is not satisfied by a document with no figures in it at all.
    expect(html).toContain('AED 4900.00')
  })

  it('prints the balance in days from day-hundredths, with no float', () => {
    // 2150 hundredths is 21.50 days. Integer arithmetic throughout (ADR 0007's reasoning applied to the
    // leave ledger): a division would print 21.499999999999996 on some values.
    expect(html).toContain('21.50 days')
    expect(html).toContain('3.00 days')
  })

  it('carries the leave form, posting to its own path', () => {
    expect(html).toContain('<form method="post" action="/hr/me">')
    expect(html).toContain('name="from"')
    expect(html).toContain('name="to"')
    // No employee field of any kind: the subject is the session's, and a body field for it would be the
    // same defect as a query parameter one layer down.
    expect(html).not.toContain('name="employee"')
  })

  it('says a balance nobody has accrued is ABSENT and not zero', () => {
    // 0066's distinction, carried to the screen: an employee with no movement has no row in
    // `leave_balance`, and "0.00 days" would be a figure nobody computed.
    const empty = renderStaffPortalHtml(
      view({ leaveBalanceHundredths: null, leaveReservedHundredths: null }),
    )
    expect(empty).toContain('data-portal-leave-balance="none"')
    expect(empty).toContain('no leave movement is on file for you yet')
    expect(empty).not.toContain('0.00 days')
  })

  it('says the commission module is DISABLED rather than showing an empty table', () => {
    const off = renderStaffPortalHtml(view({ commissionEnabled: false, commission: [] }))
    expect(off).toContain('data-portal-commission="module_disabled"')
    expect(off).toContain('Y9-commission')
    // The control: with the module on and no lines, the screen says there are no lines — a different
    // sentence, because an empty screen and a switched-off engine are a business problem and a setting.
    const onWithNothing = renderStaffPortalHtml(view({ commissionEnabled: true, commission: [] }))
    expect(onWithNothing).toContain('data-portal-commission="none"')
  })

  it('names an empty shift list as empty rather than printing nothing', () => {
    const noShifts = renderStaffPortalHtml(view({ shifts: [] }))
    expect(noShifts).toContain('data-portal-shifts="none"')
    expect(noShifts).toContain('no published rota version covers these dates')
  })

  it('carries a refusal and a confirmation on the form when there is one', () => {
    const refused = renderStaffPortalHtml(
      view({
        leaveForm: {
          ...EMPTY_FORM,
          from: '2026-10-01',
          to: '2026-10-30',
          refusal: { name: 'insufficient_balance', sentence: 'The balance would go negative.' },
        },
      }),
    )
    expect(refused).toContain('data-leave-refusal="insufficient_balance"')
    expect(refused).toContain('This request was not filed')
    // The submitted dates come back so nothing is retyped.
    expect(refused).toContain('value="2026-10-01"')

    const filed = renderStaffPortalHtml(
      view({ leaveForm: { ...EMPTY_FORM, submitted: { days: 3, status: 'pending' } } }),
    )
    expect(filed).toContain('data-leave-submitted="true"')
    expect(filed).toContain('already out of your')
  })

  it('shows no bank panel figures when nothing is on file', () => {
    const none = renderStaffPortalHtml(
      view({ bank: portalBankView({ onFile: false, label: null, filedOn: null }) }),
    )
    expect(none).toContain('No bank account is on file for you')
    expect(none).not.toContain(PORTAL_BANK_MASK)
  })
})

describe('the leave filing document', () => {
  const html = renderLeaveFilingHtml({
    chrome: { googleReauth: null, sendBacklog: null, returnTo: '/hr/leave' },
    readAtLabel: '25 Sep 2026, 14:00',
    actorLabel: 'Manager 01',
    candidates: [
      { employeeId: '11111111-1111-7111-8111-111111111111', staffReference: 'Therapist 07' },
    ],
    leaveKinds: ['annual', 'sick', 'unpaid', 'other'],
    form: { employeeId: '', from: '', to: '', kind: 'annual' },
    refusal: null,
    submitted: null,
  })

  it('is a noindex document with the admin banners on it', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<meta name="robots" content="noindex, nofollow, noarchive">')
    expect(html.indexOf('<main>')).toBeGreaterThan(-1)
  })

  it('says it files and never decides', () => {
    // The screen's own statement of the boundary. Filing is this route's; approving is `/hr/leave/[id]`'s,
    // with the coverage check and the authority.
    expect(html).toContain('files a request, not a decision')
    expect(html).toContain('same validator the staff portal uses')
  })

  it('names the employee by handle, in the POST body and not in a query', () => {
    expect(html).toContain('<form method="post" action="/hr/leave">')
    expect(html).toContain('name="employee"')
    expect(html).toContain('Therapist 07')
    // A GET URL carrying an employee id is a URL that gets shared and bookmarked.
    expect(html).not.toContain('?employee=')
  })

  it('says so when there is nobody to file for', () => {
    const empty = renderLeaveFilingHtml({
      chrome: { googleReauth: null, sendBacklog: null, returnTo: '/hr/leave' },
      readAtLabel: '25 Sep 2026, 14:00',
      actorLabel: 'Manager 01',
      candidates: [],
      leaveKinds: ['annual'],
      form: { employeeId: '', from: '', to: '', kind: 'annual' },
      refusal: null,
      submitted: null,
    })
    expect(empty).toContain('data-leave-candidates="none"')
    expect(empty).not.toContain('<form method="post"')
  })
})

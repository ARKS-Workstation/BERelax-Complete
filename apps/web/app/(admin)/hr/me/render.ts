import { HUNDREDTHS_PER_DAY, type PortalBankView, safeText } from '@berelax/core'
import { tokensCss } from '@berelax/ui'
import {
  ADMIN_BANNER_CSS,
  type AdminChrome,
  renderAdminBanner,
} from '../../../../src/components/admin/google-reauth-banner.ts'

/**
 * `/hr/me` — the staff portal document (P-HR-14).
 *
 * Pure: a view in, a document out, no database and no clock. The instant the page was read at arrives in
 * the view and is printed on it, which is the rule the HR screens next door follow — a screen that said
 * "as of now" could not produce two identical screenshots on a repeat run.
 *
 * ## Why this is a document served by a route handler and not a `page.tsx`
 *
 * The manifest's `files` list says `app/(admin)/staff/me/page.tsx`, and both halves are corrected in a
 * NOTE — the same correction P-HR-02, P-HR-06, P-HR-07 and P-HR-11 each recorded. `registry.ts` is in
 * exact bijection with the filesystem and requires every **document** to be served in both locales
 * (`registry.test.ts`: "gives every document a locale"), so a `page.tsx` would need an Arabic admin
 * document nobody has built. And the path is under `/hr` rather than a new `/staff` prefix because `/hr`
 * is already in `ADMIN_GROUP_PREFIXES`, so this route is noindex and behind `requiresAdminSession` from
 * the commit that creates it rather than from the commit that remembers to add a prefix.
 *
 * ## What is NOT on this page, and why each absence is deliberate
 *
 * **No colleague.** Not a name, not a staff reference, not a shift. The rows reaching this renderer were
 * refused for anybody but the viewer before the query ran (`assertPortalSubject`), so there is no
 * filtering here to get wrong — see `packages/core/src/hr/self-service.ts`.
 *
 * **No wage and no identity document.** `PORTAL_EMPLOYEE_FIELDS` enumerates what may appear and
 * `portalFieldPolicyProblems` refuses anything whose sensitivity is not `open`, so the salary columns and
 * the identity-document group cannot reach this file at all. `packages/core/src/hr/self-service.test.ts`
 * asserts the set; `apps/web/src/hr-me-render.test.ts` asserts the BYTES, which is the half that catches a
 * figure arriving through some other field.
 *
 * **No bank account number.** {@link renderBank} prints `PORTAL_BANK_MASK` and the view it is handed has
 * nowhere to put a number: the portal never calls `readBankDetail`, so nothing decrypts one. The mask is
 * the absence of the value and not a redaction of a value this renderer holds, which is the difference
 * between a mask and a `substring`.
 */

/** One published shift, as the page needs it. Times pre-formatted: a renderer with a clock is not pure. */
export interface PortalShiftView {
  readonly tradingDate: string
  readonly startsAtLabel: string
  readonly endsAtLabel: string
  readonly rotaVersionNo: number
}

export interface PortalLeaveRequestView {
  readonly kind: string
  readonly status: string
  readonly fromLabel: string
  readonly toLabel: string
}

export interface PortalCommissionLineView {
  readonly tradingDate: string
  readonly basisFils: number
  readonly commissionFils: number
}

export interface PortalPayslipView {
  readonly periodStartsOn: string
  readonly periodEndsOn: string
  readonly grossFils: number
  readonly deductionsFils: number
  readonly netFils: number
}

/** What a submitted leave request was answered with, carried back so nothing is retyped. */
export interface PortalLeaveFormView {
  readonly from: string
  readonly to: string
  readonly kind: string
  readonly refusal: { readonly name: string; readonly sentence: string } | null
  readonly submitted: { readonly days: number; readonly status: string } | null
}

export interface PortalPageView {
  readonly chrome: AdminChrome
  readonly readAtIso: string
  readonly readAtLabel: string
  /** The handle and never a name: nineteen employees have no name recorded (ADR 0020). */
  readonly staffReference: string
  readonly employedFrom: string
  readonly employedUntil: string | null
  readonly contractType: string
  readonly displayName: string | null
  readonly shiftsFromLabel: string
  readonly shiftsToLabel: string
  readonly shifts: readonly PortalShiftView[]
  readonly leaveRequests: readonly PortalLeaveRequestView[]
  /** Null when the employee has no leave movement at all — which is NOT a balance of zero (0066). */
  readonly leaveBalanceHundredths: number | null
  readonly leaveReservedHundredths: number | null
  readonly leaveForm: PortalLeaveFormView
  readonly leaveKinds: readonly string[]
  readonly commission: readonly PortalCommissionLineView[]
  readonly commissionEnabled: boolean
  readonly payslips: readonly PortalPayslipView[]
  readonly bank: PortalBankView
}

const PORTAL_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    padding: var(--space-7) var(--gutter);
    background: var(--color-ground);
    color: var(--color-ink);
    font: 1rem/1.55 system-ui, sans-serif;
  }
  main { max-width: 68rem; margin: 0 auto; }
  h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 var(--space-3); }
  h2 { font-size: 1.125rem; margin: var(--space-7) 0 var(--space-3); }
  p { margin: 0 0 var(--space-5); }
  .card, .policy {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-2);
    background: var(--color-surface-sand);
    padding: var(--space-5);
    margin: 0 0 var(--space-5);
  }
  .card { background: var(--color-surface); border-color: var(--color-hairline); }
  .policy { border-inline-start-width: var(--space-2); }
  dl { display: grid; grid-template-columns: auto 1fr; gap: var(--space-2) var(--space-5); margin: 0; }
  dt { font-weight: 600; }
  dd { margin: 0; }
  table { border-collapse: collapse; width: 100%; }
  caption { text-align: start; font-weight: 600; padding: 0 0 var(--space-3); }
  th, td { text-align: start; padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-hairline); }
  td.num, th.num { text-align: end; font-variant-numeric: tabular-nums; }
  form { display: grid; gap: var(--space-3); max-width: 28rem; }
  label { display: grid; gap: var(--space-1); font-weight: 600; }
  input, select, button {
    font: inherit;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-1);
    background: var(--color-surface);
    color: var(--color-ink);
    min-height: 2.75rem;
  }
  button { font-weight: 600; cursor: pointer; }
  .masked { font-variant-numeric: tabular-nums; letter-spacing: 0.08em; }
`

/** Fils as AED, integer arithmetic only (ADR 0007): never a float, never `toFixed` on a division. */
function aedLabel(fils: number): string {
  const sign = fils < 0 ? '-' : ''
  const absolute = Math.abs(fils)
  return `${sign}AED ${Math.trunc(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`
}

/** Day-hundredths as days. Same reason: the balance is stored in hundredths so it never needs a float. */
function dayLabel(hundredths: number): string {
  const sign = hundredths < 0 ? '-' : ''
  const absolute = Math.abs(hundredths)
  return `${sign}${Math.trunc(absolute / HUNDREDTHS_PER_DAY)}.${String(
    absolute % HUNDREDTHS_PER_DAY,
  ).padStart(2, '0')} days`
}

/**
 * The bank panel. The mask, the label, the filing date — and no field a number could arrive in.
 *
 * `view.maskedNumber` is a constant on the view's TYPE (`PORTAL_BANK_MASK`), so there is no value of the
 * view for which this prints digits. That is what "masked on display" means here, and it is a stronger
 * claim than masking a string the renderer held: see the module header.
 */
function renderBank(view: PortalBankView): string {
  if (!view.onFile) {
    return (
      '<div class="policy"><p><strong>No bank account is on file for you.</strong> Payroll cannot pay ' +
      'by transfer until one is filed, which the office does — there is no control here to file one, ' +
      'because a bank account is written with an audit row naming who filed it.</p></div>'
    )
  }
  return [
    '<div class="card">',
    '<dl>',
    '<dt>Account</dt>',
    `<dd class="masked" data-portal-bank="masked">${safeText(view.maskedNumber)}</dd>`,
    '<dt>Filed under</dt>',
    `<dd>${view.label === null ? 'no label' : safeText(view.label)}</dd>`,
    '<dt>Filed on</dt>',
    `<dd>${view.filedOn === null ? 'unrecorded' : safeText(view.filedOn)}</dd>`,
    '</dl>',
    '<p>The number itself is never shown on this page and is not read to render it. If the account is ' +
      'wrong, the office files a new one — a bank account is superseded and never edited.</p>',
    '</div>',
  ].join('')
}

function renderLeaveForm(view: PortalPageView): string {
  const selected = (kind: string): string => (kind === view.leaveForm.kind ? ' selected' : '')
  return [
    view.leaveForm.refusal === null
      ? ''
      : `<div class="policy" data-leave-refusal="${safeText(view.leaveForm.refusal.name)}">` +
        `<p><strong>This request was not filed.</strong> ${safeText(
          view.leaveForm.refusal.sentence,
        )}</p></div>`,
    view.leaveForm.submitted === null
      ? ''
      : `<div class="policy" data-leave-submitted="true"><p><strong>Filed: ` +
        `${safeText(dayLabel(view.leaveForm.submitted.days * HUNDREDTHS_PER_DAY))}, ` +
        `${safeText(view.leaveForm.submitted.status)}.</strong> The days are already out of your ` +
        'balance below: a request reserves when it is made, and a decision only makes the reservation ' +
        'final.</p></div>',
    '<form method="post" action="/hr/me">',
    '<label>From<input type="date" name="from" required ' +
      `value="${safeText(view.leaveForm.from)}"></label>`,
    '<label>To<input type="date" name="to" required ' +
      `value="${safeText(view.leaveForm.to)}"></label>`,
    '<label>Kind<select name="kind">',
    ...view.leaveKinds.map(
      (kind) => `<option value="${safeText(kind)}"${selected(kind)}>${safeText(kind)}</option>`,
    ),
    '</select></label>',
    '<button type="submit">Request leave</button>',
    '</form>',
  ].join('')
}

export function renderStaffPortalHtml(view: PortalPageView): string {
  return [
    '<!doctype html>',
    '<html lang="en" dir="ltr">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    // No brand in the title: docs/09's "brand collision" forbids the bare brand in any title, and
    // `apps/web/src/seo/brand.test.ts` scans every title-bearing line in `apps/web` for it.
    '<title>Your details — staff</title>',
    `<style>${tokensCss()}${PORTAL_CSS}${ADMIN_BANNER_CSS}</style>`,
    '</head>',
    '<body>',
    '<main>',
    renderAdminBanner(view.chrome),
    '<h1>Your details</h1>',
    '<div class="policy">',
    "<p><strong>This page shows your own record and nobody else's.</strong> That is a refusal in the " +
      'query and not a filter on this page: a request naming another employee is refused before any row ' +
      "is read, for every role including the owner. A colleague's figures are read on the admin screens, " +
      'which have their own authority rules.</p>',
    `<p>Read at ${safeText(view.readAtLabel)} Dubai.</p>`,
    '</div>',

    '<h2>You</h2>',
    '<div class="card"><dl>',
    '<dt>Staff reference</dt>',
    `<dd data-portal-staff-reference="${safeText(view.staffReference)}">${safeText(
      view.staffReference,
    )}</dd>`,
    '<dt>Name on file</dt>',
    // The handle is the label and the name is optional: nineteen employees have no display name
    // recorded, and a portal that printed "unknown" where a name goes would read as a data fault
    // rather than as a consent the business has not asked for (ADR 0020).
    `<dd>${view.displayName === null ? 'none recorded' : safeText(view.displayName)}</dd>`,
    '<dt>Employed from</dt>',
    `<dd>${safeText(view.employedFrom)}</dd>`,
    '<dt>Employed until</dt>',
    `<dd>${view.employedUntil === null ? 'current' : safeText(view.employedUntil)}</dd>`,
    '<dt>Contract</dt>',
    `<dd>${safeText(view.contractType)}</dd>`,
    '</dl></div>',

    '<h2>Your shifts</h2>',
    `<p>Published shifts from ${safeText(view.shiftsFromLabel)} to ${safeText(
      view.shiftsToLabel,
    )}. These are the PUBLISHED rota and not the draft the office is editing, which is why a change you ` +
      'were told about by hand may not be here yet.</p>',
    view.shifts.length === 0
      ? '<div class="card"><p data-portal-shifts="none">No published shift falls in this window. That ' +
        'is not "you are not working": it is that no published rota version covers these dates for ' +
        'you.</p></div>'
      : [
          '<table><caption>Published shifts</caption><thead><tr>',
          '<th scope="col">Trading date</th><th scope="col">From</th><th scope="col">To</th>',
          '<th scope="col" class="num">Rota version</th>',
          '</tr></thead><tbody>',
          ...view.shifts.map(
            (shift) =>
              `<tr><td>${safeText(shift.tradingDate)}</td><td>${safeText(
                shift.startsAtLabel,
              )}</td><td>${safeText(shift.endsAtLabel)}</td><td class="num">${
                shift.rotaVersionNo
              }</td></tr>`,
          ),
          '</tbody></table>',
        ].join(''),

    '<h2>Your leave</h2>',
    '<div class="card"><dl>',
    '<dt>Balance</dt>',
    `<dd data-portal-leave-balance="${
      view.leaveBalanceHundredths === null ? 'none' : String(view.leaveBalanceHundredths)
    }">${
      view.leaveBalanceHundredths === null
        ? 'no leave movement is on file for you yet'
        : safeText(dayLabel(view.leaveBalanceHundredths))
    }</dd>`,
    '<dt>Reserved by pending requests</dt>',
    `<dd>${
      view.leaveReservedHundredths === null
        ? 'none'
        : safeText(dayLabel(view.leaveReservedHundredths))
    }</dd>`,
    '</dl></div>',
    renderLeaveForm(view),
    view.leaveRequests.length === 0
      ? '<div class="card"><p data-portal-leave="none">You have filed no leave requests.</p></div>'
      : [
          '<table><caption>Your leave requests</caption><thead><tr>',
          '<th scope="col">From</th><th scope="col">To</th><th scope="col">Kind</th>',
          '<th scope="col">Status</th></tr></thead><tbody>',
          ...view.leaveRequests.map(
            (request) =>
              `<tr><td>${safeText(request.fromLabel)}</td><td>${safeText(
                request.toLabel,
              )}</td><td>${safeText(request.kind)}</td><td>${safeText(request.status)}</td></tr>`,
          ),
          '</tbody></table>',
        ].join(''),

    '<h2>Your commission</h2>',
    view.commissionEnabled
      ? view.commission.length === 0
        ? '<div class="card"><p data-portal-commission="none">No commission line is derived for you in ' +
          'the newest run of this period.</p></div>'
        : [
            '<table><caption>Commission derivation</caption><thead><tr>',
            '<th scope="col">Trading date</th><th scope="col" class="num">Basis</th>',
            '<th scope="col" class="num">Commission</th></tr></thead><tbody>',
            ...view.commission.map(
              (line) =>
                `<tr><td>${safeText(line.tradingDate)}</td><td class="num">${safeText(
                  aedLabel(line.basisFils),
                )}</td><td class="num">${safeText(aedLabel(line.commissionFils))}</td></tr>`,
            ),
            '</tbody></table>',
          ].join('')
      : '<div class="policy"><p data-portal-commission="module_disabled"><strong>The commission module ' +
        'is DISABLED, which is why there are no figures.</strong> This is not "no commission is due": no ' +
        'commission structure has been agreed (Y9-commission), so the build has configured none rather ' +
        'than guessing a rate.</p></div>',

    '<h2>Your payslips</h2>',
    view.payslips.length === 0
      ? '<div class="card"><p data-portal-payslips="none">No completed payroll run holds a payslip for ' +
        'you.</p></div>'
      : [
          '<table><caption>Payslips</caption><thead><tr>',
          '<th scope="col">Period</th><th scope="col" class="num">Gross</th>',
          '<th scope="col" class="num">Deductions</th><th scope="col" class="num">Net</th>',
          '</tr></thead><tbody>',
          ...view.payslips.map(
            (slip) =>
              `<tr><td>${safeText(slip.periodStartsOn)} to ${safeText(
                slip.periodEndsOn,
              )}</td><td class="num">${safeText(
                aedLabel(slip.grossFils),
              )}</td><td class="num">${safeText(
                aedLabel(slip.deductionsFils),
              )}</td><td class="num">${safeText(aedLabel(slip.netFils))}</td></tr>`,
          ),
          '</tbody></table>',
        ].join(''),

    '<h2>Where you are paid</h2>',
    renderBank(view.bank),
    '</main>',
    '</body>',
    '</html>',
  ].join('')
}

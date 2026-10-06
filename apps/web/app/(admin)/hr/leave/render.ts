import { safeText } from '@berelax/core'
import { tokensCss } from '@berelax/ui'
import { ADMIN_SHELL_CSS, renderAdminChromeClose, renderAdminChromeOpen } from '@berelax/ui/admin'
import {
  ADMIN_BANNER_CSS,
  type AdminChrome,
  renderAdminBanner,
} from '../../../../src/components/admin/google-reauth-banner.ts'

/**
 * `/hr/leave` — filing leave FOR somebody, the admin half of P-HR-14's submission path.
 *
 * ## Why this screen exists rather than only the portal
 *
 * Nineteen employees have no phone number and no email on file (0081), so a therapist who cannot reach
 * `/hr/me` still has to be able to take a holiday, and a manager typing it in is how that happens. The
 * acceptance line asks for "both entry points call one function", and this is the second entry point:
 * both this route and `/hr/me` call `submitLeaveRequest` in `@berelax/hr`, and
 * `packages/fixtures/src/leave-submission-entry-points.test.ts` asserts by source scan that neither
 * reaches `writeLeaveRequest` itself.
 *
 * ## The employee is named in the BODY and never in the query
 *
 * `apps/web/src/admin-guard.test.ts` refuses a principal, a role or a permission taken from the query
 * across the whole of `apps/web`. A SUBJECT is a different thing from a principal — it says whose leave
 * this is, not who is asking — and it is carried in the POST body rather than the query for two
 * independent reasons: a GET URL with an employee id in it is a URL that gets shared and bookmarked, and
 * the authority to file on somebody's behalf is checked against the SESSION's role
 * (`assertOnBehalfAuthority`, which requires `leave:approve`) rather than against anything submitted.
 *
 * It names the employee by `staff_reference` and never by a person's name: nineteen have none recorded
 * (ADR 0020, brief rule 10).
 */

export interface LeaveFilingCandidateView {
  readonly employeeId: string
  readonly staffReference: string
}

export interface LeaveFilingPageView {
  readonly chrome: AdminChrome
  readonly readAtLabel: string
  /** The handle of whoever is signed in, printed so the screen says who the row will be attributed to. */
  readonly actorLabel: string
  readonly candidates: readonly LeaveFilingCandidateView[]
  readonly leaveKinds: readonly string[]
  readonly form: {
    readonly employeeId: string
    readonly from: string
    readonly to: string
    readonly kind: string
  }
  readonly refusal: { readonly name: string; readonly sentence: string } | null
  readonly submitted: {
    readonly staffReference: string
    readonly days: number
    readonly status: string
  } | null
}

const FILING_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    padding: var(--space-7) var(--gutter);
    background: var(--color-ground);
    color: var(--color-ink);
    font: 1rem/1.55 system-ui, sans-serif;
  }
  main { max-width: 52rem; margin: 0 auto; }
  h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 var(--space-3); }
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
`

export function renderLeaveFilingHtml(view: LeaveFilingPageView): string {
  const selectedKind = (kind: string): string => (kind === view.form.kind ? ' selected' : '')
  const selectedEmployee = (id: string): string => (id === view.form.employeeId ? ' selected' : '')
  return [
    '<!doctype html>',
    '<html lang="en" dir="ltr">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    '<title>File leave — HR admin</title>',
    `<style>${tokensCss()}${ADMIN_SHELL_CSS}${FILING_CSS}${ADMIN_BANNER_CSS}</style>`,
    '</head>',
    '<body>',
    renderAdminChromeOpen({
      title: 'Leave',
      path: '/hr/leave',
      role: view.chrome.role,
      staffReference: view.chrome.staffReference,
    }),
    '<main>',
    renderAdminBanner(view.chrome),
    '<h1>File leave for a member of staff</h1>',
    '<div class="policy">',
    '<p><strong>This files a request, not a decision.</strong> It enters the same validator the staff ' +
      'portal uses — the balance, the probation rule and the leave year are all judged by one function — ' +
      "and the row is created PENDING. Approving it is the leave screen's, which checks the floor " +
      'coverage and the authority.</p>',
    "<p>The days are reserved the moment the request is filed. That is the ledger's rule and not this " +
      "screen's: a request reserves when it is made and a decision only makes the reservation final, so " +
      'filing a request somebody cannot fund is refused here rather than at approval.</p>',
    `<p>Filed as ${safeText(view.actorLabel)}. Read at ${safeText(view.readAtLabel)} Dubai.</p>`,
    '</div>',
    view.refusal === null
      ? ''
      : `<div class="policy" data-leave-refusal="${safeText(view.refusal.name)}">` +
        `<p><strong>Nothing was filed.</strong> ${safeText(view.refusal.sentence)}</p></div>`,
    view.submitted === null
      ? ''
      : '<div class="policy" data-leave-submitted="true"><p><strong>Filed for ' +
        `${safeText(view.submitted.staffReference)}: ${view.submitted.days} day(s), ` +
        `${safeText(view.submitted.status)}.</strong> The days are reserved against their balance ` +
        'already.</p></div>',
    view.candidates.length === 0
      ? '<div class="card"><p data-leave-candidates="none">No current employee is on file, so there is ' +
        'nobody to file leave for.</p></div>'
      : [
          '<form method="post" action="/hr/leave">',
          '<label>Employee<select name="employee" required>',
          ...view.candidates.map(
            (candidate) =>
              `<option value="${safeText(candidate.employeeId)}"${selectedEmployee(
                candidate.employeeId,
              )}>${safeText(candidate.staffReference)}</option>`,
          ),
          '</select></label>',
          `<label>From<input type="date" name="from" required value="${safeText(
            view.form.from,
          )}"></label>`,
          `<label>To<input type="date" name="to" required value="${safeText(view.form.to)}"></label>`,
          '<label>Kind<select name="kind">',
          ...view.leaveKinds.map(
            (kind) =>
              `<option value="${safeText(kind)}"${selectedKind(kind)}>${safeText(kind)}</option>`,
          ),
          '</select></label>',
          '<button type="submit">File request</button>',
          '</form>',
        ].join(''),
    '</main>',
    renderAdminChromeClose(),
    '</body>',
    '</html>',
  ].join('')
}

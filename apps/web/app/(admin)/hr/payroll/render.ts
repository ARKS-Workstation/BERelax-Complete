import { safeText } from '@berelax/core'
import { tokensCss } from '@berelax/ui'
import { ADMIN_SHELL_CSS, renderAdminChromeClose, renderAdminChromeOpen } from '@berelax/ui/admin'
import {
  ADMIN_BANNER_CSS,
  type AdminChrome,
  renderAdminBanner,
} from '../../../../src/components/admin/google-reauth-banner.ts'

/**
 * The payroll screen: which runs exist over a period, what each payslip is made of, and what is blocking.
 *
 * Pure: rows in, a document out, no database and no clock. The instant the page was read at arrives in the
 * view and is printed on it, which is the rule the five HR screens next door follow — a screen that said "as
 * of now" could not produce two identical screenshots on a repeat run.
 *
 * ## Why this is a document served by a route handler and not a `page.tsx`
 *
 * The manifest's `files` list says `page.tsx`, and it is corrected in a NOTE — the same correction P-HR-02,
 * P-HR-06, P-HR-07 and P-HR-11 each recorded, for the same reason. `apps/web/src/routes/registry.ts` is in
 * exact bijection with the filesystem and requires every **document** to be served in both locales
 * (`registry.test.ts`: "gives every document a locale"), so a `page.tsx` here would need an Arabic admin
 * document nobody has built, and it would join a screenshot matrix whose RTL half must be a real Arabic
 * route. The PAYSLIP is bilingual, which is where the Arabic requirement actually bites; this screen is the
 * operator's console.
 *
 * ## The three things this screen exists to say
 *
 * **1. What is stopping payroll.** An employee with no wage on file, an employee with no approved timesheet,
 * and a period holding an INCOMPLETE attendance row are three different blocks with three different
 * remedies, and the one thing they must never do is look like "nobody is owed anything". So they are
 * printed first, named, and counted — never summarised as a total that happens to be low.
 *
 * **2. What each figure is made of.** Every payslip line names the version that produced it: the commission
 * run and its rule version, the timesheet approval, and the wage divisor the run pinned. That is the
 * difference between a payslip and a printout of a total — a figure somebody can go and check.
 *
 * **3. That a completed run is final.** A run that is wrong is corrected by a NEW dated run naming it, and
 * the screen says so beside every completed run rather than offering an edit that the database would refuse.
 *
 * It names no therapist. `staff_reference` is the handle and nineteen employees have no name recorded (ADR
 * 0020, brief rule 10).
 *
 * It is READ-ONLY. Running payroll is a write with an actor, a period and an immutable result, and a run
 * recorded by a curious click is a row nothing can delete (ZY141) — `executePayrollRun` in `@berelax/hr` is
 * the entry point. Exporting a WPS file is the same argument twice over, because the export is the
 * insider-threat signal: the button that produces one belongs behind a deliberate action, not on the page
 * that lists the runs.
 */

/** Money as `AED 1,234.56` from integer fils. Never a float: the split is integer division and a remainder. */
function asAed(fils: number): string {
  const sign = fils < 0 ? '-' : ''
  const absolute = Math.abs(fils)
  const dirhams = Math.trunc(absolute / 100)
  const remainder = absolute % 100
  return `${sign}AED ${dirhams.toLocaleString('en-GB')}.${String(remainder).padStart(2, '0')}`
}

export interface PayslipLineView {
  readonly staffReference: string
  readonly basicFils: number
  readonly allowancesFils: number
  readonly overtimeFils: number
  readonly commissionFils: number
  readonly tipsFils: number
  readonly grossFils: number
  readonly deductionsFils: number
  readonly netFils: number
  readonly payableMinutes: number
  readonly commissionRunId: string | null
  readonly commissionRuleVersion: number | null
  readonly timesheetApprovalId: string
  readonly workingHoursRuleEffectiveFrom: string
}

export interface PayrollRunView {
  readonly runId: string
  readonly periodStartsOn: string
  readonly periodEndsOn: string
  readonly payslipCount: number
  readonly netTotalFils: number
  readonly unpricedEmployeeCount: number
  readonly completedAtIso: string | null
  readonly completedBy: string | null
  readonly correctsRunId: string | null
  readonly labourCostRuleEffectiveFrom: string
}

export interface WpsExportView {
  readonly exportedAtIso: string
  readonly exportedBy: string
  readonly recordCount: number
  readonly fileSha256: string
  readonly format: string
}

export interface PayrollPageView {
  /** The Google re-auth banner and the page a reconnect comes back to (G-CONN-08). Required, not optional. */
  readonly chrome: AdminChrome
  readonly readAtIso: string
  readonly periodStartsOn: string
  readonly periodEndsOn: string
  readonly runs: readonly PayrollRunView[]
  /** The newest run's payslips, scoped to whoever the viewer is allowed to see. */
  readonly payslips: readonly PayslipLineView[]
  /** Whose payslip is shown, and whether the viewer is limited to their own. */
  readonly subject: { readonly staffReference: string; readonly ownOnly: boolean }
  /** Exports taken of the newest run. Listed because an export is the insider-threat signal. */
  readonly exports: readonly WpsExportView[]
  /** The WPS identifiers, and whether each is still the placeholder the build ships. */
  readonly wps: {
    readonly employerIdConfigured: boolean
    readonly agentIdConfigured: boolean
    readonly openQuestionId: string
  }
  /** From `periodStatusOn` — the one reader. `earliestOpenDate` equals the end date when it is open. */
  readonly accountingPeriod: {
    readonly closed: boolean
    readonly periodId: string | null
    readonly earliestOpenDate: string
  }
}

const DUBAI = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Dubai',
  dateStyle: 'medium',
  timeStyle: 'short',
})

/** Every colour is a token. `pnpm colours` refuses a literal hex outside the token layer (brief rule 11). */
const PAYROLL_CSS = `
main { max-width: 74rem; margin: 0 auto; padding: 1.5rem; font-family: var(--font-sans); color: var(--color-ink); }
h1 { font-size: 1.6rem; margin-bottom: 0.5rem; }
h2 { font-size: 1.15rem; margin-top: 2rem; border-top: 1px solid var(--color-rule); padding-top: 0.75rem; }
.policy { background: var(--color-surface-2); padding: 0.85rem 1rem; border-radius: 0.4rem; }
.policy p { margin: 0 0 0.6rem; line-height: 1.55; }
.policy p:last-child { margin-bottom: 0; }
.blocked { border-inline-start: 3px solid var(--color-ink); padding-inline-start: 0.85rem; }
.empty { color: var(--color-ink-2); }
table { width: 100%; border-collapse: collapse; margin-top: 0.75rem; }
th, td { text-align: start; padding: 0.4rem 0.5rem; border-bottom: 1px solid var(--color-rule); vertical-align: top; }
td.num, th.num { text-align: end; font-variant-numeric: tabular-nums; white-space: nowrap; }
tr.total td, tr.total th { font-weight: 600; border-top: 2px solid var(--color-ink); }
.rows { list-style: none; padding: 0; }
.rows li { border-bottom: 1px solid var(--color-rule); padding: 0.6rem 0; }
.pin { color: var(--color-ink-2); font-size: 0.85rem; }
code { font-family: var(--font-mono); font-size: 0.85rem; word-break: break-all; }
`

function runLine(run: PayrollRunView): string {
  return [
    '<li>',
    `<strong>${safeText(run.periodStartsOn)} to ${safeText(run.periodEndsOn)}</strong> — `,
    `${run.payslipCount} payslip(s), ${safeText(asAed(run.netTotalFils))} net. `,
    run.completedAtIso === null
      ? '<strong>DRAFT.</strong> Nothing has been paid against it and no WPS file may be taken of it. ' +
        'A draft accepts exactly one change — being completed.'
      : `Completed ${safeText(DUBAI.format(new Date(run.completedAtIso)))} Dubai by ` +
        `${safeText(String(run.completedBy))}. It is now immutable: a figure that is wrong is corrected ` +
        'by a NEW dated run naming this one, never by an edit.',
    run.correctsRunId === null
      ? ''
      : ` <span class="pin">Corrects run <code>${safeText(run.correctsRunId)}</code>.</span>`,
    run.unpricedEmployeeCount > 0
      ? ` <span class="pin">${run.unpricedEmployeeCount} employee(s) had no wage on file and were ` +
        'counted rather than paid as zero.</span>'
      : '',
    ` <span class="pin">Wage divisor version ${safeText(run.labourCostRuleEffectiveFrom)}; ` +
      `run <code>${safeText(run.runId)}</code>.</span>`,
    '</li>',
  ].join('')
}

function payslipRow(line: PayslipLineView): string {
  return [
    '<tr>',
    `<th scope="row">${safeText(line.staffReference)}<br>`,
    // The pins, under the handle. A payslip that named no version would be a figure nobody can check, and
    // this is the screen on which somebody goes looking.
    `<span class="pin">${line.payableMinutes} payable minutes; hours rule `,
    `${safeText(line.workingHoursRuleEffectiveFrom)}; `,
    line.commissionRunId === null
      ? 'no commission run (no structure is configured)'
      : `commission run <code>${safeText(line.commissionRunId)}</code> v${safeText(String(line.commissionRuleVersion))}`,
    '</span></th>',
    `<td class="num">${safeText(asAed(line.basicFils))}</td>`,
    `<td class="num">${safeText(asAed(line.allowancesFils))}</td>`,
    `<td class="num">${safeText(asAed(line.overtimeFils))}</td>`,
    `<td class="num">${safeText(asAed(line.commissionFils))}</td>`,
    `<td class="num">${safeText(asAed(line.tipsFils))}</td>`,
    `<td class="num">${safeText(asAed(line.grossFils))}</td>`,
    `<td class="num">${safeText(asAed(line.deductionsFils))}</td>`,
    `<td class="num"><strong>${safeText(asAed(line.netFils))}</strong></td>`,
    '</tr>',
  ].join('')
}

export function renderPayrollHtml(view: PayrollPageView): string {
  const newest = view.runs[0]
  const netTotal = view.payslips.reduce((sum, line) => sum + line.netFils, 0)
  const tipTotal = view.payslips.reduce((sum, line) => sum + line.tipsFils, 0)
  const wpsBlocked = !view.wps.employerIdConfigured || !view.wps.agentIdConfigured
  return [
    '<!doctype html>',
    '<html lang="en" dir="ltr">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    // No brand in the title: docs/09's "brand collision" forbids the bare brand in any title, and
    // `apps/web/src/seo/brand.test.ts` scans every title-bearing line in `apps/web` for it.
    '<title>Payroll — HR admin</title>',
    `<style>${tokensCss()}${ADMIN_SHELL_CSS}${PAYROLL_CSS}${ADMIN_BANNER_CSS}</style>`,
    '</head>',
    '<body>',
    renderAdminChromeOpen({
      title: 'Payroll',
      path: '/hr/payroll',
      role: view.chrome.role,
      staffReference: view.chrome.staffReference,
    }),
    '<main>',
    renderAdminBanner(view.chrome),
    '<h1>Payroll</h1>',
    '<div class="policy">',
    `<p><strong>${safeText(view.periodStartsOn)} to ${safeText(view.periodEndsOn)}, read at ` +
      `${safeText(DUBAI.format(new Date(view.readAtIso)))} Dubai.</strong> Trading dates, not calendar ` +
      'dates: the premises closes after midnight, so a treatment in the small hours belongs to the day that ' +
      'opened the evening before — and therefore to that day’s payroll period.</p>',
    /*
      The WPS state, FIRST and unconditional, for the reason the commission screen prints its disabled
      state first: a screen with no export on it is indistinguishable from a screen nobody has used, and
      the two are a question to answer and an ordinary Tuesday.
    */
    wpsBlocked
      ? `<p class="blocked"><strong>No WPS file can be produced yet.</strong> The ` +
        `${!view.wps.employerIdConfigured ? 'employer identifier' : ''}` +
        `${!view.wps.employerIdConfigured && !view.wps.agentIdConfigured ? ' and the ' : ''}` +
        `${!view.wps.agentIdConfigured ? 'agent identifier' : ''} ` +
        `${!view.wps.employerIdConfigured && !view.wps.agentIdConfigured ? 'are' : 'is'} still the ` +
        `placeholder this build ships (${safeText(view.wps.openQuestionId)}). That is deliberate: the ` +
        'establishment or MOL number is registered to this business and nobody has supplied it, and a ' +
        'plausible-looking number would produce a file that passes every check and pays staff against ' +
        'another employer’s registration. The export is refused by name until it is set, which is one ' +
        'audited settings change and no deploy.</p>'
      : '<p>The WPS identifiers are set. A file is still produced by a person deciding to produce one, and ' +
        'every export is recorded with its row count and the digest of its bytes — an export of wages is ' +
        'the insider-threat signal this system watches most closely. There is no submission path in this ' +
        'software: the file is handed to the bank by a human.</p>',
    view.accountingPeriod.closed
      ? `<p><strong>The accounting period covering these dates is closed</strong> ` +
        `(${safeText(String(view.accountingPeriod.periodId))}), so a new payroll run over it is refused. ` +
        `The earliest OPEN date is ${safeText(view.accountingPeriod.earliestOpenDate)}.</p>`
      : '<p>The accounting period covering these dates is open, so a run over it may be created.</p>',
    '</div>',
    '<h2>Runs over this period</h2>',
    view.runs.length === 0
      ? '<p class="empty">No payroll run has been computed for this period. That is not “nobody is owed ' +
        'anything”: it is that nobody has run payroll. Running it is a deliberate action with an actor, ' +
        'and its result is a record nothing can delete.</p>'
      : `<ul class="rows">${view.runs.map(runLine).join('')}</ul>`,
    '<h2>Payslips</h2>',
    view.subject.ownOnly
      ? `<p>Showing <strong>${safeText(view.subject.staffReference)}</strong> only — you. Your role may ` +
        'read your own payslip and not a colleague’s: reading somebody else’s pay needs the payroll ' +
        'permission, which the matrix grants to the owner and the accountant and deliberately not to the ' +
        'floor manager. There is no way to ask for another employee’s from this screen.</p>'
      : '<p>Showing <strong>every employee</strong> the newest run paid. Your role holds the payroll ' +
        'permission, which is what reading somebody else’s pay requires. Every read of this page is ' +
        'recorded with your name and the number of rows it returned.</p>',
    newest === undefined || view.payslips.length === 0
      ? '<p class="empty">No payslips to show for this period.</p>'
      : [
          '<table>',
          '<thead><tr><th scope="col">Employee</th><th scope="col" class="num">Basic</th>',
          '<th scope="col" class="num">Allowances</th><th scope="col" class="num">Overtime</th>',
          '<th scope="col" class="num">Commission</th><th scope="col" class="num">Tips</th>',
          '<th scope="col" class="num">Gross</th><th scope="col" class="num">Deductions</th>',
          '<th scope="col" class="num">Net</th></tr></thead>',
          `<tbody>${view.payslips.map(payslipRow).join('')}</tbody>`,
          '<tfoot><tr class="total"><th scope="row">Total shown</th>',
          '<td class="num" colspan="7"></td>',
          `<td class="num">${safeText(asAed(netTotal))}</td></tr></tfoot>`,
          '</table>',
          // Tips get their own sentence, not just their own column: the acceptance line is that a tip is a
          // separate line and never revenue, and the screen is where somebody would otherwise assume the
          // salon earned it.
          tipTotal > 0
            ? `<p class="pin">${safeText(asAed(tipTotal))} of the total above is tips. A tip is the ` +
              'customer’s money on its way to a therapist: the salon holds it as a liability and pays it ' +
              'on, and it never reaches a revenue account.</p>'
            : '',
        ].join(''),
    '<h2>WPS exports of this run</h2>',
    view.exports.length === 0
      ? '<p class="empty">No file has been exported from this run.</p>'
      : `<ul class="rows">${view.exports
          .map(
            (row) =>
              `<li>${safeText(DUBAI.format(new Date(row.exportedAtIso)))} Dubai by ` +
              `${safeText(row.exportedBy)} — ${row.recordCount} record(s), layout ` +
              `${safeText(row.format)}. <span class="pin">sha256 <code>${safeText(row.fileSha256)}</code>` +
              '</span></li>',
          )
          .join('')}</ul>`,
    '</main>',
    renderAdminChromeClose(),
    '</body>',
    '</html>',
  ].join('')
}

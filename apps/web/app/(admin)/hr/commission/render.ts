import { safeText } from '@berelax/core'
import { tokensCss } from '@berelax/ui'
import { ADMIN_SHELL_CSS, renderAdminChromeClose, renderAdminChromeOpen } from '@berelax/ui/admin'
import {
  ADMIN_BANNER_CSS,
  type AdminChrome,
  renderAdminBanner,
} from '../../../../src/components/admin/google-reauth-banner.ts'

/**
 * The commission screen: which rule version judged a period, what each appointment earned, and — today —
 * that the module is switched off.
 *
 * Pure: rows in, a document out, no database and no clock. The instant the page was read at arrives in the
 * view and is printed on it, which is the rule the four HR screens next door follow: a screen that said "as
 * of now" could not produce two identical screenshots on a repeat run.
 *
 * ## Why this is a document served by a route handler and not a `page.tsx`
 *
 * The manifest's `files` list says `page.tsx`, and it is corrected in a NOTE — the same correction P-HR-02,
 * P-HR-06 and P-HR-07 each recorded, for the same reason. `apps/web/src/routes/registry.ts` is in exact
 * bijection with the filesystem and requires every **document** to be served in both locales
 * (`registry.test.ts`: "gives every document a locale"), so a `page.tsx` here would need an Arabic admin
 * document nobody has built, and it would join a screenshot matrix whose RTL half must be a real Arabic
 * route.
 *
 * ## The one thing this screen exists to say today
 *
 * **The module is DISABLED, and that is why there are no figures.** The acceptance line is "with the module
 * disabled by default the engine produces zero lines and the disabled state is visible in the admin UI and
 * in the Unconfirmed Assumptions panel — no silent success", and the two halves of that are what this file
 * is mostly about. An empty commission screen is indistinguishable from a month in which nobody earned
 * anything, and of those two the first is a switch somebody has to flip and the second is a business
 * problem. So the state is printed FIRST, unconditionally, with the open question's id on it.
 *
 * The second thing it says, and it is the subject of the unit: **which version judged each run, and when its
 * figures were read**. A run over a closed month reads the books as filed, and the screen prints that
 * instant — because "why does the recomputed March differ from the March we paid" is answered by that field
 * and by nothing else.
 *
 * It names no therapist. `staff_reference` is the handle and nineteen employees have no name recorded (ADR
 * 0020, brief rule 10).
 *
 * It is READ-ONLY. Publishing a rule version and computing a run are writes with an actor and a period, and
 * neither is something to put behind a button on a page whose purpose is to explain that nothing is
 * configured.
 */

/** Money as `AED 1,234.56` from integer fils. Never a float: the split is integer division and a remainder. */
function asAed(fils: number): string {
  const sign = fils < 0 ? '-' : ''
  const absolute = Math.abs(fils)
  const dirhams = Math.trunc(absolute / 100)
  const remainder = absolute % 100
  return `${sign}AED ${dirhams.toLocaleString('en-GB')}.${String(remainder).padStart(2, '0')}`
}

/** A rate in basis points as a percentage, exactly. 1,250bp is 12.5% and 1,255bp is 12.55%. */
function asPercent(rateBp: number): string {
  const whole = Math.trunc(rateBp / 100)
  const hundredths = rateBp % 100
  return hundredths === 0
    ? `${whole}%`
    : `${whole}.${String(hundredths).padStart(2, '0').replace(/0$/, '')}%`
}

export interface CommissionBandView {
  readonly bandNo: number
  readonly fromFils: number
  readonly rateBp: number
}

export interface CommissionRuleVersionView {
  readonly version: number
  readonly effectiveFrom: string
  readonly basis: string
  readonly roundingMode: string
  readonly openQuestionId: string | null
  readonly bands: readonly CommissionBandView[]
  /** True when a later version exists. Derived, because superseded-ness is never a stored column (0097). */
  readonly superseded: boolean
}

export interface CommissionRunView {
  readonly runId: string
  readonly ruleVersion: number
  readonly totalFils: number
  readonly lineCount: number
  /** The instant the source figures were read at. For a locked period, the lock's own `locked_at`. */
  readonly sourceAsOf: string
  readonly lockedPeriodId: string | null
  readonly moduleEnabled: boolean
  readonly computedAt: string
}

export interface CommissionDerivationLineView {
  readonly staffReference: string
  readonly appointmentId: string
  readonly tradingDate: string
  readonly source: string
  readonly basisFils: number
  readonly bandNo: number
  readonly rateBp: number
  readonly commissionFils: number
}

export interface CommissionPageView {
  /** The Google re-auth banner and the page a reconnect comes back to (G-CONN-08). Required, not optional. */
  readonly chrome: AdminChrome
  readonly readAtIso: string
  readonly periodStartsOn: string
  readonly periodEndsOn: string
  /** From the settings registry — `hr.commission_enabled`, `false` and provisional against Y9-commission. */
  readonly moduleEnabled: boolean
  readonly moduleOpenQuestionId: string
  readonly versions: readonly CommissionRuleVersionView[]
  readonly runs: readonly CommissionRunView[]
  /** The newest run's derivation, scoped to whoever the viewer is allowed to see. */
  readonly derivation: readonly CommissionDerivationLineView[]
  /** Whose derivation is shown, and whether the viewer is limited to their own. */
  readonly subject: { readonly staffReference: string; readonly ownOnly: boolean }
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
const COMMISSION_CSS = `
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
  h3 { font-size: 1rem; margin: var(--space-5) 0 var(--space-2); }
  p { margin: 0 0 var(--space-5); }
  .policy, .card {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-2);
    background: var(--color-surface-sand);
    padding: var(--space-5);
    margin: 0 0 var(--space-5);
  }
  .policy { border-inline-start-width: var(--space-2); }
  .card { background: var(--color-surface); border-color: var(--color-hairline); }
  dl { display: grid; grid-template-columns: auto 1fr; gap: var(--space-2) var(--space-5); margin: 0; }
  dt { font-weight: 600; }
  dd { margin: 0; }
  ul.rows { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-3); }
  ul.rows li {
    background: var(--color-surface);
    border: 1px solid var(--color-hairline);
    border-inline-start: var(--space-2) solid var(--color-border);
    border-radius: var(--radius-2);
    padding: var(--space-3) var(--space-5);
  }
  code { font-family: ui-monospace, monospace; }
  .empty { color: var(--color-ink-muted); }
`

function bandLine(band: CommissionBandView): string {
  return (
    `<li>Band ${band.bandNo}: from ${safeText(asAed(band.fromFils))} at ` +
    `<strong>${safeText(asPercent(band.rateBp))}</strong> (${band.rateBp}bp)</li>`
  )
}

function versionSection(version: CommissionRuleVersionView): string {
  return [
    `<h3>Version ${version.version}, effective ${safeText(version.effectiveFrom)}` +
      `${version.superseded ? ' (superseded)' : ''}</h3>`,
    '<div class="card"><dl>',
    `<dt>Applies to</dt><dd><code>${safeText(version.basis)}</code></dd>`,
    `<dt>Rounds</dt><dd><code>${safeText(version.roundingMode)}</code>, which is a figure on the version ` +
      'rather than a convention in code: it is worth one fil per line and real money over a month</dd>',
    version.openQuestionId === null
      ? '<dt>Confirmed</dt><dd>yes — this version is not flagged provisional</dd>'
      : `<dt>Provisional</dt><dd>${safeText(version.openQuestionId)}. Nobody has confirmed these figures, ` +
        'so they appear on the Unconfirmed Assumptions panel</dd>',
    '</dl></div>',
    `<ul class="rows">${version.bands.map(bandLine).join('')}</ul>`,
    // Printed for every version, superseded or not, because a version that judged a run must stay readable:
    // that is what makes the run reproducible at all.
    version.superseded
      ? '<p class="empty">Superseded, and still the version that judged every run naming it. A recompute ' +
        'of such a run uses THIS version, never the current one — which is what stops a rate change ' +
        'restating a month that has already been paid.</p>'
      : '',
  ].join('')
}

function runLine(run: CommissionRunView): string {
  const filed =
    run.lockedPeriodId === null
      ? 'The period was OPEN, so the figures were read at the instant the run was computed and that ' +
        'instant is stored — a recompute uses it rather than reading the rows as they are now.'
      : `The period was CLOSED (${safeText(run.lockedPeriodId)}), so the figures were read AS FILED. A ` +
        'payment applied after the close, or a sale backdated into the month, cannot move this total.'
  return [
    '<li>',
    `<strong>${safeText(asAed(run.totalFils))}</strong> over ${run.lineCount} appointment(s), under rule ` +
      `version ${run.ruleVersion}.`,
    `<br>Computed ${safeText(DUBAI.format(new Date(run.computedAt)))} Dubai; source figures as at ` +
      `${safeText(DUBAI.format(new Date(run.sourceAsOf)))} Dubai.`,
    `<br>${filed}`,
    run.moduleEnabled ? '' : '<br>The module was DISABLED when this ran.',
    '</li>',
  ].join('')
}

function derivationLine(line: CommissionDerivationLineView): string {
  return (
    `<li><strong>${safeText(line.tradingDate)}</strong> ${safeText(line.staffReference)} — ` +
    `${safeText(asAed(line.commissionFils))} on ${safeText(asAed(line.basisFils))} at ` +
    `${safeText(asPercent(line.rateBp))} (band ${line.bandNo}), from ` +
    `<code>${safeText(line.source)}</code>.<br>Appointment <code>${safeText(line.appointmentId)}</code></li>`
  )
}

export function renderCommissionHtml(view: CommissionPageView): string {
  const newest = view.runs[0]
  const derivationTotal = view.derivation.reduce((sum, line) => sum + line.commissionFils, 0)
  return [
    '<!doctype html>',
    '<html lang="en" dir="ltr">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    // No brand in the title: docs/09's "brand collision" forbids the bare brand in any title, and
    // `apps/web/src/seo/brand.test.ts` scans every title-bearing line in `apps/web` for it.
    '<title>Commission — HR admin</title>',
    `<style>${tokensCss()}${ADMIN_SHELL_CSS}${COMMISSION_CSS}${ADMIN_BANNER_CSS}</style>`,
    '</head>',
    '<body>',
    renderAdminChromeOpen({
      title: 'Commission',
      path: '/hr/commission',
      role: view.chrome.role,
      staffReference: view.chrome.staffReference,
    }),
    '<main>',
    renderAdminBanner(view.chrome),
    '<h1>Commission</h1>',
    '<div class="policy">',
    /*
      FIRST, and unconditional. An empty commission screen is indistinguishable from a month in which
      nobody earned anything, and the two are a switch to flip and a business problem. The acceptance line
      says "no silent success" and this paragraph is it.
    */
    view.moduleEnabled
      ? '<p><strong>The commission module is ENABLED.</strong> Every figure below was computed from a ' +
        'published rule version, and each run names the version that judged it.</p>'
      : `<p><strong>The commission module is DISABLED, which is why there are no figures.</strong> ` +
        `This is not "no commission is due": it is that no commission structure has been agreed ` +
        `(${safeText(view.moduleOpenQuestionId)}), so the build has configured none rather than guessing a ` +
        'rate. A guessed rate would be indistinguishable from an agreed one on the payslip that resulted. ' +
        'The engine is complete and is exercised against a fixture rule set; turning it on is one audited ' +
        'settings change plus one published rule version, and neither is a deploy.</p>',
    `<p><strong>${safeText(view.periodStartsOn)} to ${safeText(view.periodEndsOn)}, read at ` +
      `${safeText(DUBAI.format(new Date(view.readAtIso)))} Dubai.</strong> Trading dates, not calendar ` +
      'dates: the premises closes after midnight, so a treatment in the small hours belongs to the day that ' +
      'opened the evening before — and therefore to that day’s commission period.</p>',
    view.accountingPeriod.closed
      ? `<p><strong>The accounting period covering these dates is closed</strong> ` +
        `(${safeText(String(view.accountingPeriod.periodId))}). A run over it reads the figures AS FILED, ` +
        `so it reproduces. The earliest OPEN date is ` +
        `${safeText(view.accountingPeriod.earliestOpenDate)}.</p>`
      : '<p>The accounting period covering these dates is open, so a run over it stores the instant its ' +
        'figures were read at and a recompute uses that instant rather than today’s rows.</p>',
    '</div>',
    '<h2>Rule versions</h2>',
    view.versions.length === 0
      ? '<p class="empty">No commission rule version is published. Nothing is seeded, deliberately: there ' +
        'is no law about commission and no figure in the handover, so the table is empty rather than ' +
        'holding a rate this build invented. Every rate lives in a versioned row; none lives in code.</p>'
      : view.versions.map(versionSection).join(''),
    '<h2>Runs over this period</h2>',
    view.runs.length === 0
      ? '<p class="empty">No run has been computed for this period.</p>'
      : `<ul class="rows">${view.runs.map(runLine).join('')}</ul>`,
    view.runs.length > 1
      ? '<p class="empty">More than one run, which is ordinary and is the point: a period computed again is ' +
        'a NEW run whose figures can be compared with the first, never an edit of it. A run and its lines ' +
        'refuse every UPDATE and DELETE.</p>'
      : '',
    '<h2>Derivation</h2>',
    view.subject.ownOnly
      ? `<p>Showing <strong>${safeText(view.subject.staffReference)}</strong> only — you. Your role may read ` +
        'your own commission and not a colleague’s: a commission is pay, and reading somebody else’s pay ' +
        'needs the payroll permission. There is no way to ask for another employee’s from this screen.</p>'
      : '<p>Showing <strong>every employee</strong> the newest run commissioned. Your role holds the ' +
        'payroll permission, which is what reading somebody else’s pay requires.</p>',
    newest === undefined
      ? '<p class="empty">There is no run to derive from.</p>'
      : view.derivation.length === 0
        ? '<p class="empty">The newest run commissioned no appointment in the scope shown.</p>'
        : [
            `<ul class="rows">${view.derivation.map(derivationLine).join('')}</ul>`,
            // The per-appointment rows and the total they sum to, printed together, because the acceptance
            // line is that they agree — and the run header is an INDEPENDENT figure held equal to the lines
            // by the database (ZY074), not a sum of the rows above.
            `<div class="card"><dl><dt>These rows</dt><dd>${safeText(asAed(derivationTotal))}</dd>` +
              `<dt>Run total</dt><dd>${safeText(asAed(newest.totalFils))} over ${newest.lineCount} ` +
              'appointment(s), for everybody. The header is stored independently of the lines and the ' +
              'database refuses a run whose header disagrees with them</dd></dl></div>',
          ].join(''),
    '<p class="empty">Commission is computed only from appointments that were COMPLETED and whose document ' +
      'was PAID. A no-show, a cancellation and a completed-but-unpaid visit each earn nothing, and a ' +
      'package redemption earns on the value it RECOGNISED — not on what the course sold for.</p>',
    '</main>',
    renderAdminChromeClose(),
    '</body>',
    '</html>',
  ].join('')
}

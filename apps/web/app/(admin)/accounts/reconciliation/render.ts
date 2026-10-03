import { safeText } from '@berelax/core'
import { tokensCss } from '@berelax/ui'
import {
  ADMIN_BANNER_CSS,
  type AdminChrome,
  renderAdminBanner,
} from '../../../../src/components/admin/google-reauth-banner.ts'

/**
 * The closed-month reconciliation, as HTML (M-VAT-12).
 *
 * Pure: a report in, a document out, no database and no clock. The report carries its own period and its
 * own `sourceAsOf`, and both are printed — a screen that said "as of now" could not produce two identical
 * screenshots on a repeat run, and could not answer "what did this look like when the month was filed",
 * which is the only question the page is for.
 *
 * ## What this page is FOR, which decides its whole shape
 *
 * It is the artefact handed to an FTA-registered tax agent ([UNVERIFIED] Y11-tax-agent). So it is a list
 * of named claims, each with the two figures it compares, the variance between them, and the FUNCTION each
 * figure came from. Not a narrative: a reconciliation written as prose cannot be checked, and the thing a
 * reviewer does with this page is pick a line and ask where the number is from.
 *
 * Two things follow that are worth stating because the obvious alternative is worse:
 *
 *   * **A variance is shown as a variance, never as a total that happens to differ.** The whole point is
 *     that "these two figures differ by 4,200 fils" is a sentence somebody can act on, and "revenue was
 *     47,500" is not.
 *   * **A line that makes no claim says so.** The report's `stated` kind is rendered as "reported, nothing
 *     claimed" rather than as a tick. A screen that showed a green tick beside a figure nothing checked
 *     would be the reason the next reviewer stops reading the ticks.
 *
 * ## Why this is a document served by a route handler and not a `page.tsx`
 *
 * `apps/web/src/routes/registry.ts` is in exact bijection with the filesystem and requires every
 * **document** to be served in both locales, so a `page.tsx` here would need an Arabic admin document and
 * the admin shell W-SYS-01 has not built, and it would join a screenshot matrix whose RTL half must be a
 * real Arabic route. The compliance calendar, the Messages inbox and the credentials screen are the
 * precedents. This surface is English-only on purpose: a tax agent's working paper is an English document.
 *
 * ## What it must never show
 *
 * A TRN. None is on file ([UNVERIFIED] Y1-trn) and nothing on this page needs one: a reconciliation is
 * about figures and the documents behind them, and the supplier identity belongs on the invoice. Nor a
 * customer name or phone number — every figure here is an aggregate, and a reconciliation that listed
 * customers would be a marketing list with a variance column.
 */

/** One side of one line, as the page shows it. */
export interface ReconciliationSideView {
  readonly label: string
  /** Integer fils, as a decimal STRING. A `number` here would round a figure the page is about. */
  readonly fils: string
  readonly rowsExamined: number
}

/** One line of the report, flattened for rendering. `bigint` never reaches this module. */
export interface ReconciliationLineView {
  readonly id: string
  readonly kind: 'identity' | 'excluded' | 'census' | 'stated'
  readonly measure: 'fils' | 'rows'
  readonly claim: string
  readonly left: ReconciliationSideView
  readonly right: ReconciliationSideView
  /** The variance in the line's own measure, as a decimal string. `"0"` when the claim holds. */
  readonly variance: string
  readonly derivedFrom: string
}

export interface ReconciliationView {
  readonly chrome: AdminChrome
  readonly periodId: string
  readonly startsOn: string
  readonly endsOn: string
  readonly closed: boolean
  readonly lockedPeriodId: string | null
  readonly sourceAsOf: string
  readonly lines: readonly ReconciliationLineView[]
  readonly unexplainedVarianceLines: readonly string[]
  readonly examinedRows: number
  readonly notExportableReasons: readonly string[]
  readonly caveats: readonly string[]
}

const RECONCILIATION_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    padding: var(--space-7) var(--gutter);
    background: var(--color-ground);
    color: var(--color-ink);
    font: 1rem/1.55 system-ui, sans-serif;
  }
  main { max-width: 74rem; margin: 0 auto; }
  h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 var(--space-3); }
  h2 { font-size: 1.125rem; margin: var(--space-7) 0 var(--space-3); }
  p { margin: 0 0 var(--space-5); }
  .banner {
    border: 1px solid var(--color-border);
    border-inline-start-width: var(--space-2);
    border-radius: var(--radius-2);
    padding: var(--space-5);
    margin: 0 0 var(--space-5);
    background: var(--color-surface-sand);
  }
  .banner-variance { border-inline-start-color: var(--color-danger); }
  .banner-clear { border-inline-start-color: var(--color-success); }
  .banner-caveat { border-inline-start-color: var(--color-accent-gold); }
  .banner h2 { margin: 0 0 var(--space-3); font-size: 1rem; }
  .banner p:last-child { margin-bottom: 0; }
  .provenance {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-2);
    background: var(--color-surface);
    padding: var(--space-5);
    margin: 0 0 var(--space-7);
  }
  .provenance ul { margin: var(--space-3) 0 0; padding-inline-start: var(--space-7); }
  table { width: 100%; border-collapse: collapse; margin-top: var(--space-3); }
  caption {
    text-align: start;
    color: var(--color-ink-2);
    font-size: 0.875rem;
    padding-bottom: var(--space-3);
  }
  th, td {
    text-align: start;
    padding: var(--space-3);
    border-bottom: 1px solid var(--color-hairline);
    vertical-align: top;
  }
  th { font-size: 0.875rem; color: var(--color-ink-2); }
  td.figure { font-variant-numeric: tabular-nums; white-space: nowrap; text-align: end; }
  code { font-size: 0.875rem; }
  .flag { display: inline-flex; align-items: center; gap: var(--space-3); white-space: nowrap; }
  .dot { width: var(--space-4); height: var(--space-4); border-radius: var(--radius-handle); flex: none; }
  .dot-holds { background: var(--color-success); }
  .dot-variance { background: var(--color-danger); }
  .dot-stated { background: var(--color-ink-3); }
  .from { font-size: 0.875rem; color: var(--color-ink-2); }
`

/**
 * Fils as dirhams and fils, with the fils figure kept beside it.
 *
 * Both, and the integer one is not decoration: money is integer fils and VAT-inclusive gross is
 * authoritative (ADR 0007), so `AED 420.00` is a rendering and `42000` is the figure. A reviewer comparing
 * this page against a `psql` session needs the second one, and a page that showed only the first would
 * make a one-fil variance invisible at exactly the scale a one-fil variance matters.
 *
 * String arithmetic and never `Number`: a `number` rounds above 2^53, and `queries/trial-balance.ts`
 * records the four fils a `number` invented out of a ledger that balanced.
 */
export function formatFils(fils: string): string {
  const negative = fils.startsWith('-')
  const digits = (negative ? fils.slice(1) : fils).padStart(3, '0')
  const dirhams = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${negative ? '−' : ''}AED ${dirhams}.${digits.slice(-2)}`
}

/** `output_tax_against_the_vat201_box` reads as a handle; the sentence reads as a claim. */
function label(value: string): string {
  return value.replaceAll('_', ' ').replace(/^./, (character) => character.toUpperCase())
}

/**
 * The verdict cell: the word first, with the colour as a second signal and never the only one.
 *
 * A verdict told by colour alone cannot be read by a colour-blind reviewer, which docs/08 treats as a
 * defect — and here it would be the difference between "this month reconciles" and "it does not".
 */
function verdictCell(line: ReconciliationLineView): string {
  if (line.kind === 'stated') {
    return (
      '<span class="flag"><span class="dot dot-stated" aria-hidden="true"></span>' +
      'reported, nothing claimed</span>'
    )
  }
  if (line.variance === '0') {
    return '<span class="flag"><span class="dot dot-holds" aria-hidden="true"></span>holds</span>'
  }
  const out =
    line.measure === 'fils' ? formatFils(line.variance) : `${safeText(line.variance)} row(s)`
  return `<span class="flag"><span class="dot dot-variance" aria-hidden="true"></span>out by ${out}</span>`
}

const sideCell = (side: ReconciliationSideView, measure: 'fils' | 'rows'): string =>
  `<td class="figure">${
    measure === 'fils' ? formatFils(side.fils) : `${side.rowsExamined} row(s)`
  }<br><span class="from">${safeText(side.label)}${
    measure === 'fils' ? `, ${side.rowsExamined} row(s) read` : `, ${formatFils(side.fils)}`
  }</span></td>`

function lineRow(line: ReconciliationLineView): string {
  return (
    '<tr>' +
    `<th scope="row"><code>${safeText(line.id)}</code><br>${safeText(line.claim)}` +
    `<br><span class="from">from ${safeText(line.derivedFrom)}</span></th>` +
    `<td>${safeText(label(line.kind))}, in ${safeText(line.measure)}</td>` +
    sideCell(line.left, line.measure) +
    sideCell(line.right, line.measure) +
    `<td>${verdictCell(line)}</td>` +
    '</tr>'
  )
}

export function renderMonthReconciliationHtml(view: ReconciliationView): string {
  const banner =
    view.unexplainedVarianceLines.length === 0
      ? '<div class="banner banner-clear"><h2>Every line holds</h2><p>No identity in this ' +
        'reconciliation is out by a single fil, and no appointment, document or tender is unaccounted ' +
        `for. ${view.examinedRows} row(s) were examined — a reconciliation over a month with nothing in ` +
        'it would also report no variance, so that figure is the one to read first.</p></div>'
      : `<div class="banner banner-variance"><h2>${view.unexplainedVarianceLines.length} line(s) do not ` +
        'hold</h2><p>The month does not reconcile and may not be handed to the tax agent. Out: ' +
        `${view.unexplainedVarianceLines.map((id) => safeText(id)).join(', ')}.</p></div>`

  // A SEPARATE banner, and the separation is the point: "this arithmetic does not add up" and "nobody has
  // confirmed which box number this is" are different facts with different remedies, and a screen that
  // added them together would show a red count on a month that reconciles exactly. After a fortnight of
  // that nobody reads the red count, which is what makes such a screen worse than none.
  const caveats =
    view.caveats.length === 0
      ? ''
      : '<div class="banner banner-caveat"><h2>What is not confirmed</h2><ul>' +
        `${view.caveats.map((reason) => `<li>${safeText(reason)}</li>`).join('')}</ul>` +
        '<p>None of these is a variance. The arithmetic on this page is asserted by the build; its ' +
        'correctness against FTA practice is not.</p></div>'

  const exportability =
    view.notExportableReasons.length === 0
      ? '<p><strong>Exportable.</strong> The report may be handed to the tax agent, and every export ' +
        'writes an <code>audit_event</code> carrying the content hash of the exact bytes handed over.</p>'
      : '<p><strong>Not exportable.</strong></p><ul>' +
        `${view.notExportableReasons.map((reason) => `<li>${safeText(reason)}</li>`).join('')}</ul>`

  return [
    '<!doctype html>',
    '<html lang="en" dir="ltr">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    // No brand in the title: docs/09's "brand collision" forbids the bare brand in any title, and a
    // back-office working paper has no reason to name the business at all.
    '<title>Month reconciliation — admin</title>',
    `<style>${tokensCss()}${RECONCILIATION_CSS}${ADMIN_BANNER_CSS}</style>`,
    '</head>',
    '<body>',
    '<main>',
    renderAdminBanner(view.chrome),
    `<h1>Reconciliation for ${safeText(view.periodId)}</h1>`,
    banner,
    caveats,
    '<div class="provenance">',
    `<p><strong>${safeText(view.startsOn)} to ${safeText(view.endsOn)}</strong>, read as at ` +
      `<strong>${safeText(view.sourceAsOf)}</strong>.</p>`,
    '<ul>',
    view.closed
      ? `<li>The period is <strong>closed</strong> by lock <code>${safeText(
          view.lockedPeriodId ?? '',
        )}</code>, and every figure is read as at that lock’s own instant. A closed month is a statement ` +
        'about what the books said when they were filed, so this page shows the same figures next year as ' +
        'it does today.</li>'
      : '<li>The period is <strong>open</strong>. Every figure on this page can still move, which is why ' +
        'the report is not exportable: there is nothing yet for a lock to be the authority on.</li>',
    '<li>Nothing on this page is derived twice. Each line names the function its figures came from, and ' +
      'where this report had to refine the ledger to tell one document apart from another, ' +
      '<code>ledger_census_against_the_trial_balance</code> is the line that ties the refinement back to ' +
      'the trial balance.</li>',
    '<li>Money is integer fils and VAT-inclusive gross is authoritative, so VAT is <em>gross less net</em> ' +
      'and the dirham figures beside each amount are a rendering of the integer, never the other way ' +
      'round.</li>',
    '</ul>',
    exportability,
    '</div>',
    '<h2>The lines</h2>',
    '<table><caption>Every claim this reconciliation makes, the two figures it compares, where each one ' +
      'came from, and whether it holds</caption><thead><tr>' +
      '<th scope="col">Claim</th><th scope="col">Kind</th><th scope="col">Documents</th>' +
      '<th scope="col">Ledger</th><th scope="col">Verdict</th>' +
      `</tr></thead><tbody>${view.lines.map(lineRow).join('')}</tbody></table>`,
    '</main>',
    '</body>',
    '</html>',
  ].join('')
}

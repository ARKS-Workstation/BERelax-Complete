import type { CredentialAssessment, CredentialEvaluation, CredentialStatus } from '@berelax/core'
import { safeText } from '@berelax/core'
import { tokensCss } from '@berelax/ui'

/**
 * The HR credentials screen, as HTML.
 *
 * Pure: rows in, a document out, no database and no clock. The evaluation instant arrives in the view
 * and is printed on the page, which is the same rule the evaluator itself follows — a screen that said
 * "as of now" could not produce two identical screenshots on a repeat run, and could not be asked "what
 * did this look like on the 31st".
 *
 * ## Why this is a document served by a route handler and not a `page.tsx`
 *
 * `apps/web/src/routes/registry.ts` is in exact bijection with the filesystem and requires every
 * **document** to be served in both locales (`registry.test.ts`: "gives every document a locale"), so a
 * `page.tsx` here would need an Arabic admin document and the admin shell W-SYS-01 has not built, and it
 * would join a screenshot matrix whose RTL half must be a real Arabic route. The Messages inbox and the
 * breakpoint preview are the two precedents, one directory along, and both give this reason. This
 * surface is English-only on purpose: it shows an HR administrator which credentials are current.
 *
 * ## What it must never show
 *
 * A document number. `employee_document.number_ct` is a ciphertext under `STAFF_PII_KEK` and the only
 * path to a plaintext is the audited decrypt in `packages/hr/src/employee-repository.ts`; this page
 * reads none of it and prints "recorded" or "not recorded" instead. The employee is identified by
 * `staff_reference` — the internal handle, "Therapist 07" — and never by a name, because nineteen of
 * them have no name recorded and the ones that do have it under a publication guard (ADR 0020).
 */

/** One employee's row on the screen. `reference` is the internal handle, never a person's name. */
export interface CredentialRow {
  readonly employeeId: string
  readonly reference: string
  readonly evaluation: CredentialEvaluation
  /** Per document type, whether a number is sealed on file. Never the number. */
  readonly sealedNumbers: Readonly<Record<string, boolean>>
}

export interface CredentialsView {
  readonly rows: readonly CredentialRow[]
  /** The profile version the mandatory set came from, so the page names the row it judged against. */
  readonly profileVersion: number
  readonly mandatoryTypes: readonly string[]
  readonly nonExpiringTypes: readonly string[]
  readonly expiringSoonDays: number
  /** The instant every status on the page was computed at, as ISO 8601. */
  readonly evaluatedAtIso: string
}

const CREDENTIALS_CSS = `
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
  h2 { font-size: 1.125rem; margin: 0; }
  p { margin: 0 0 var(--space-5); }
  .policy {
    border: 1px solid var(--color-border);
    border-inline-start-width: var(--space-2);
    border-radius: var(--radius-2);
    background: var(--color-surface-sand);
    padding: var(--space-5);
    margin: 0 0 var(--space-7);
  }
  .policy ul { margin: var(--space-3) 0 0; padding-inline-start: var(--space-7); }
  ol.people { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-5); }
  article {
    background: var(--color-surface);
    border: 1px solid var(--color-hairline);
    border-radius: var(--radius-2);
    padding: var(--space-5);
  }
  .head { display: flex; flex-wrap: wrap; gap: var(--space-3) var(--space-5); align-items: baseline; }
  .verdict { display: inline-flex; align-items: center; gap: var(--space-3); font-weight: 600; }
  .dot { width: var(--space-4); height: var(--space-4); border-radius: var(--radius-handle); }
  .dot-VALID { background: var(--color-success); }
  .dot-EXPIRING_SOON { background: var(--color-accent-gold); }
  .dot-EXPIRED { background: var(--color-danger); }
  .dot-MISSING { background: var(--color-ink-3); }
  table { width: 100%; border-collapse: collapse; margin-top: var(--space-5); }
  caption { text-align: start; color: var(--color-ink-2); font-size: 0.875rem; padding-bottom: var(--space-3); }
  th, td { text-align: start; padding: var(--space-3); border-bottom: 1px solid var(--color-hairline); }
  th { font-size: 0.875rem; color: var(--color-ink-2); }
  td.days { font-variant-numeric: tabular-nums; }
  .empty {
    border: 1px dashed var(--color-border);
    border-radius: var(--radius-2);
    padding: var(--space-9) var(--space-5);
    text-align: center;
    color: var(--color-ink-2);
  }
`

/**
 * The instant, in the timezone the credential boundary is judged in.
 *
 * `Asia/Dubai` and `en-GB`, for the two reasons the Messages inbox gives: the reader is in Abu Dhabi,
 * and an implicit locale would make the rendering depend on a request header, so a repeat screenshot
 * would not be byte-identical. It matters more here than there — the whole page is a claim about which
 * day it is, and printing a UTC timestamp beside a Dubai verdict is how somebody concludes the verdict
 * is wrong.
 */
const DUBAI = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Dubai',
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

/** The document type, as a person reads it. `labour_card` is not a word anybody says out loud. */
function typeLabel(documentType: string): string {
  return documentType.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase())
}

function statusCell(status: CredentialStatus): string {
  // The word, always, with the colour as a second signal and never the only one: a status told by
  // colour alone cannot be read by a colour-blind operator, which docs/08 treats as a defect.
  return (
    `<span class="verdict"><span class="dot dot-${safeText(status)}" aria-hidden="true"></span>` +
    `${safeText(status.replace('_', ' '))}</span>`
  )
}

/** The countdown, in words a person acts on. Null days means the question does not apply. */
function daysCell(assessment: CredentialAssessment): string {
  if (assessment.daysUntilExpiry === null) {
    return assessment.status === 'MISSING' ? '—' : 'does not expire'
  }
  const days = assessment.daysUntilExpiry
  if (days < 0) return `${Math.abs(days)} days ago`
  if (days === 0) return 'today'
  return `in ${days} days`
}

function documentRow(assessment: CredentialAssessment, hasSealedNumber: boolean): string {
  return (
    '<tr>' +
    `<th scope="row">${safeText(typeLabel(assessment.documentType))}</th>` +
    `<td>${statusCell(assessment.status)}</td>` +
    `<td>${assessment.expiresOn === null ? '—' : safeText(assessment.expiresOn)}</td>` +
    `<td class="days">${safeText(daysCell(assessment))}</td>` +
    // Never the number. "Recorded" is the whole of what this surface may know about a sealed column.
    `<td>${hasSealedNumber ? 'recorded' : 'not recorded'}</td>` +
    '</tr>'
  )
}

function personArticle(row: CredentialRow): string {
  const { evaluation } = row
  const verdict = evaluation.eligible
    ? '<span class="verdict"><span class="dot dot-VALID" aria-hidden="true"></span>Eligible</span>'
    : '<span class="verdict"><span class="dot dot-EXPIRED" aria-hidden="true"></span>Not eligible' +
      '</span>'
  const assessments = [...evaluation.mandatory, ...evaluation.other]
  const rows = assessments
    .map((assessment) =>
      documentRow(assessment, row.sealedNumbers[assessment.documentType] === true),
    )
    .join('')
  const blocking = evaluation.blocking
    .map((assessment) => `${typeLabel(assessment.documentType)} (${assessment.status})`)
    .join(', ')
  return (
    '<li><article>' +
    '<div class="head">' +
    // The internal handle. Nineteen of these people have no name recorded and this page must not be
    // the screen where somebody types one in (ADR 0020, Y8-staff).
    `<h2>${safeText(row.reference)}</h2>${verdict}` +
    '</div>' +
    (evaluation.eligible
      ? ''
      : `<p>Blocked by: ${safeText(blocking)}. Eligibility needs every mandatory document unexpired; ` +
        'expiring soon is a warning and does not block.</p>') +
    '<table><caption>Mandatory documents first, in the order the regulatory profile lists them, then ' +
    'everything else on file</caption><thead><tr>' +
    '<th scope="col">Document</th><th scope="col">Status</th><th scope="col">Expires</th>' +
    '<th scope="col">When</th><th scope="col">Number</th>' +
    `</tr></thead><tbody>${rows}</tbody></table>` +
    '</article></li>'
  )
}

export function renderCredentialsHtml(view: CredentialsView): string {
  const body =
    view.rows.length === 0
      ? '<p class="empty">No employees to report on. This list is per employee and is never an ' +
        'unbounded read of every credential in the business, so an empty list means the query named ' +
        'nobody — not that nobody holds a credential.</p>'
      : `<ol class="people">${view.rows.map((row) => personArticle(row)).join('')}</ol>`

  const nonExpiring =
    view.nonExpiringTypes.length === 0
      ? 'None. Every credential must be renewed until the profile says otherwise, which is the strict ' +
        'reading and the default.'
      : view.nonExpiringTypes.map((t) => safeText(typeLabel(t))).join(', ')

  return [
    '<!doctype html>',
    '<html lang="en" dir="ltr">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    // No brand in the title, which is a rule rather than a preference and cost this unit a run to learn.
    // docs/09 §"The brand collision" forbids the bare brand in any title — berelax.com is an airport-spa
    // chain with an outlet in the same city — and `apps/web/src/seo/brand.test.ts` scans every
    // title-bearing line in `apps/web` for it. The Messages inbox next door is EXEMPT from that scan
    // because its title reads "BE RELAX admin"; this page needs no exemption, because an internal
    // back-office screen has no reason to name the business at all.
    '<title>Credentials — HR admin</title>',
    `<style>${tokensCss()}${CREDENTIALS_CSS}</style>`,
    '</head>',
    '<body>',
    '<main>',
    '<h1>Credentials</h1>',
    '<div class="policy">',
    `<p><strong>Judged at ${safeText(DUBAI.format(new Date(view.evaluatedAtIso)))} Dubai</strong>, ` +
      `against regulatory profile version ${view.profileVersion}. A document expires at the END of the ` +
      'date it carries, in Asia/Dubai: one valid through the 31st covers the 31st, and is expired from ' +
      'midnight local on the 1st — four hours before it would be by UTC.</p>',
    '<ul>',
    `<li><strong>Mandatory:</strong> ${
      view.mandatoryTypes.length === 0
        ? 'nothing. An empty set is no credential gate at all, which is a decision a lawyer takes.'
        : view.mandatoryTypes.map((t) => safeText(typeLabel(t))).join(', ')
    }</li>`,
    `<li><strong>Never expires:</strong> ${nonExpiring}</li>`,
    `<li><strong>Warns from:</strong> ${view.expiringSoonDays} days before expiry. Provisional ` +
      '(Y1-licence): the renewal intervals are [UNVERIFIED] in docs/04 §7, so the window that should ' +
      'precede them is a choice this build made and not an answer anybody gave.</li>',
    '</ul>',
    '<p>Which documents are mandatory is read from <code>regulatory_profile</code> and is not written ' +
      'anywhere in this application: a lawyer’s answer changes this page with no deploy.</p>',
    '</div>',
    body,
    '</main>',
    '</body>',
    '</html>',
  ].join('')
}

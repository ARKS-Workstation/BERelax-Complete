import { safeText } from '@berelax/core'
import type { GbpSnapshotFormField } from '@berelax/google'
import { tokensCss } from '@berelax/ui'
import { ADMIN_SHELL_CSS, renderAdminChromeClose, renderAdminChromeOpen } from '@berelax/ui/admin'
import {
  type AdminChrome,
  GOOGLE_REAUTH_BANNER_CSS,
  renderAdminBanner,
} from '../../../../../src/components/admin/google-reauth-banner.ts'
import { GBP_SNAPSHOT_FIELDS, GBP_SNAPSHOT_PATH, type GbpSnapshotView } from './view.ts'

/**
 * *Google profile snapshot* — the degraded mode, as a working screen (G-SEO-06).
 *
 * Pure: a view in, a document out. No database, no clock — the instant the page was read at arrives on
 * the view and is printed, which is what lets two repeat runs produce identical screenshots.
 *
 * ## Why a route handler and not a `page.tsx`
 *
 * The manifest's `files` list names `page.tsx`. Every admin surface in this build is a `route.ts` +
 * `render.ts` + `handler.ts` + `view.ts` instead, for the reason ADR 0086 records for the suggestions
 * queue one directory along: `apps/web/src/routes/registry.ts` requires every **document** to be served
 * in BOTH locales, so a `page.tsx` here would need an Arabic admin document that W-SYS-01 has not built.
 * The manifest carries a NOTE saying so.
 *
 * ## The form does not show what the website says
 *
 * Deliberately, and it is the most important thing about this screen. A form that pre-filled the Google
 * column with the premises row's own hours is answered by pressing Enter, and the check would then report
 * *"consistent"* about a profile nobody looked at — a self-comparison, which is the exact failure the NAP
 * rule exists to prevent, arriving through the one door a lint cannot close. So the fields are empty and
 * the findings appear **after** a submission, beside the website's figure, where they can be read as a
 * comparison rather than used as a crib.
 *
 * ## No JavaScript
 *
 * One `<form method="post">`, which works with scripting disabled. The person filling this in is reading
 * one screen and typing into another, and a script that failed to load would turn that into a support
 * call.
 */

/** Every colour is a token. `pnpm colours` refuses a literal hex outside the token layer (brief rule 11). */
const SNAPSHOT_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    padding: var(--space-7) var(--gutter);
    background: var(--color-ground);
    color: var(--color-ink);
    font: 1rem/1.55 system-ui, sans-serif;
  }
  main { max-width: 60rem; margin: 0 auto; }
  h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 var(--space-3); }
  h2 { font-size: 1.125rem; margin: var(--space-7) 0 var(--space-3); }
  p { margin: 0 0 var(--space-5); }
  .policy, .refusal, .done, .provenance {
    border: 1px solid var(--color-border);
    border-inline-start-width: var(--space-2);
    border-radius: var(--radius-2);
    background: var(--color-surface-sand);
    padding: var(--space-5);
    margin: 0 0 var(--space-5);
  }
  table { width: 100%; border-collapse: collapse; margin: 0 0 var(--space-5); }
  th, td {
    text-align: start;
    vertical-align: top;
    padding: var(--space-2) var(--space-3);
    border-top: 1px solid var(--color-hairline);
  }
  th { font-weight: 600; }
  td.copy { white-space: pre-wrap; word-break: break-word; }
  label { display: block; font-weight: 600; margin: 0 0 var(--space-2); }
  input {
    font: inherit;
    min-height: 3rem;
    width: 100%;
    max-width: 18rem;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-1);
    background: var(--color-surface);
    color: var(--color-ink);
  }
  input[type="checkbox"] { min-height: auto; width: auto; }
  ul.fields { list-style: none; margin: 0 0 var(--space-5); padding: 0; display: grid; gap: var(--space-5); }
  /* 48px, because docs/08 §4's floor is the TARGET: a claim recorded on a phone must not be a tap
     somebody misses. */
  button {
    font: inherit;
    font-weight: 600;
    min-height: 3rem;
    padding: var(--space-3) var(--space-7);
    border: 0;
    border-radius: var(--radius-1);
    background: var(--color-ink);
    color: var(--color-ground);
  }
  code { font-family: ui-monospace, monospace; }
  .empty { color: var(--color-ink-muted); }
`

function renderField(field: GbpSnapshotFormField, mayRecord: boolean): string {
  const disabled = mayRecord ? '' : ' disabled'
  const input =
    field.kind === 'closed_flag'
      ? `<input type="checkbox" id="${safeText(field.name)}" name="${safeText(field.name)}" value="yes"${disabled}>`
      : `<input type="text" inputmode="${field.kind === 'amount_aed' ? 'decimal' : 'numeric'}" ` +
        `id="${safeText(field.name)}" name="${safeText(field.name)}"${disabled}>`
  return [
    '<li>',
    `<label for="${safeText(field.name)}">${safeText(field.label)}</label>`,
    input,
    '</li>',
  ].join('')
}

function renderFindings(view: GbpSnapshotView): string {
  if (!view.compared) {
    return (
      '<p class="empty">Nothing has been compared yet. Record what the profile shows and the ' +
      'differences appear here.</p>'
    )
  }
  if (view.findings.length === 0) {
    return '<p>The profile and this site agree on everything compared.</p>'
  }
  return [
    '<table>',
    '<thead><tr><th scope="col">What</th><th scope="col">This site</th>' +
      '<th scope="col">Google</th><th scope="col">Why it matters</th></tr></thead>',
    '<tbody>',
    ...view.findings.map(
      (finding) =>
        `<tr><th scope="row">${safeText(finding.subject)}<br><code>${safeText(finding.rule)}</code></th>` +
        `<td>${safeText(finding.website.value)}<br><span class="empty">${safeText(
          finding.website.provenance.side === 'website'
            ? finding.website.provenance.authority
            : 'google',
        )}</span></td>` +
        `<td>${safeText(finding.google.value)}<br><span class="empty">${safeText(
          finding.google.provenance.side === 'google'
            ? finding.google.provenance.authority
            : 'website',
        )}</span></td>` +
        `<td class="copy">${safeText(finding.why)}</td></tr>`,
    ),
    '</tbody></table>',
  ].join('')
}

export function renderGbpSnapshotHtml(
  view: GbpSnapshotView & { readonly chrome: AdminChrome },
): string {
  const f = GBP_SNAPSHOT_FIELDS
  return [
    '<!doctype html>',
    '<html lang="en" dir="ltr">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    // No brand in the title: docs/09's brand-collision rule forbids the bare brand in any title, and
    // `apps/web/src/seo/brand.test.ts` scans every title-bearing line in `apps/web` for it.
    '<title>Google profile snapshot — agents admin</title>',
    `<style>${tokensCss()}${ADMIN_SHELL_CSS}${SNAPSHOT_CSS}${GOOGLE_REAUTH_BANNER_CSS}</style>`,
    '</head>',
    '<body>',
    renderAdminChromeOpen({
      title: 'Gbp snapshot',
      path: '/agents/seo/gbp-snapshot',
      role: view.chrome.role,
      staffReference: view.chrome.staffReference,
    }),
    '<main>',
    renderAdminBanner(view.chrome),
    '<h1>Google profile snapshot</h1>',
    '<div class="policy">',
    `<p><strong>Read at ${safeText(view.readAtIso)}.</strong> This compares what this website says ` +
      'against what the Google Business Profile shows, because when the two disagree an assistant asked ' +
      'about opening times or prices answers confidently and wrongly under this business&rsquo;s name.</p>',
    `<p>Acting as <strong>${safeText(view.actorLabel)}</strong>, which is what the recorded claim names.</p>`,
    '</div>',
    view.provenance === null
      ? ''
      : `<div class="provenance"><p>${safeText(view.provenance)}</p></div>`,
    view.recorded ? '<p class="done">Recorded.</p>' : '',
    view.refusal === null
      ? ''
      : [
          '<div class="refusal">',
          `<p><strong>Refused: <code>${safeText(view.refusal)}</code></strong></p>`,
          view.refusalDetail === null ? '' : `<p>${safeText(view.refusalDetail)}</p>`,
          '</div>',
        ].join(''),
    '<h2>Differences</h2>',
    renderFindings(view),
    view.form === null
      ? '<h2>Where these figures came from</h2><p>The Business Profile API answered, so there is ' +
        'nothing to transcribe.</p>'
      : [
          '<h2>What the profile shows</h2>',
          `<p>${safeText(view.form.reason)}</p>`,
          '<p>Open the profile in another tab and type what it says. Leave a row blank if you ' +
            'cannot see it. These are <strong>your figures</strong>, recorded against your name and the ' +
            'time you looked &mdash; nothing here has read the profile.</p>',
          view.mayRecord
            ? ''
            : '<p class="empty">Your role may not record a claim about the listing, so the fields ' +
              'below are read-only.</p>',
          `<form method="post" action="${GBP_SNAPSHOT_PATH}">`,
          `<input type="hidden" name="${f.action}" value="record">`,
          '<ul class="fields">',
          `<li><label for="${f.observedAt}">When you looked (ISO 8601)</label>` +
            `<input type="text" id="${f.observedAt}" name="${f.observedAt}"${
              view.mayRecord ? '' : ' disabled'
            }></li>`,
          ...view.form.fields.map((field) => renderField(field, view.mayRecord)),
          '</ul>',
          view.mayRecord ? '<button type="submit">Record what the profile shows</button>' : '',
          '</form>',
        ].join(''),
    '</main>',
    renderAdminChromeClose(),
    '</body>',
    '</html>',
  ].join('\n')
}

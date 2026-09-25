import type { CustomerMergeFieldPlan, CustomerMergeSubject } from '@berelax/core'
import { safeText } from '@berelax/core'
import { tokensCss } from '@berelax/ui'
import type { RenderDirection } from '../render.ts'

/**
 * The merge preview, as HTML (C-CRM-06): what a person is shown before they authorise a merge.
 *
 * Pure: a view in, a document out. Every figure on this page came out of `previewCustomerMerge`, which is
 * the REAL merge performed inside a transaction that was rolled back — so the numbers here are not a
 * description of what a merge would do, they are what a merge just did and then undid. That is the whole
 * design, and `packages/db/src/repositories/merge-preview.ts` states why nothing else is acceptable.
 *
 * ## What a reviewer actually needs, and why each part is on the page
 *
 *   - **Which record is kept**, named, with the number and the date each was created, because the default
 *     is the earlier record and the earlier record is sometimes the one with the mistyped number on it.
 *   - **A way to keep the other one instead.** One link, which re-previews the pair the other way round.
 *     The counts change, and seeing them change is the point: it is the only way to tell that the choice
 *     was heard.
 *   - **Per table: what moves, what is copied, and what stays behind with a reason.** A row retained on the
 *     tombstone is the one a reviewer would otherwise think had been lost, so `merge_record_table`'s
 *     `retained_reason` is printed rather than summarised.
 *   - **The consent state before and after.** The reviewer's real question is "will this person still be
 *     sendable", and it is the one thing the row counts cannot answer: a merged log is folded by
 *     `resolveConsent`, and a withdrawal on either record governs the survivor when it is the newest thing
 *     either of them said.
 *   - **What was discarded.** `phone_e164` is UNIQUE, so one record cannot hold both numbers; a
 *     verification proves somebody answered a code sent to ONE number. Both are shown as
 *     `not_transferable` with the reason, because a merge that resolved a conflict must not look like one
 *     that found none.
 *
 * ## The confirm step
 *
 * A form, POSTing to this same route. It requires a stated reason and a stated authoriser, because
 * `merge_record`'s CHECKs refuse a placeholder in either (0069) — and because the provisional line on this
 * unit is that every merge is confirmed by a named human. No JavaScript: the form works with scripting off,
 * and there is no confirm dialog to click through absent-mindedly.
 */

export interface PreviewRecordView {
  readonly subject: CustomerMergeSubject
  /** What the candidate scan and the scorer said about the pair, printed for the reviewer's context. */
  readonly role: 'survivor' | 'loser'
}

export interface PreviewTableView {
  readonly participant: string
  readonly strategy: string
  readonly rowsBeforeSurvivor: number
  readonly rowsBeforeLoser: number
  readonly rowsAfterSurvivor: number
  readonly rowsAfterLoser: number
  readonly rowsMoved: number
  readonly rowsInserted: number
  readonly rowsRetainedOnLoser: number
  readonly retainedReason: string | null
}

export interface PreviewConsentView {
  readonly channel: string
  readonly purpose: string
  readonly before: string
  readonly after: string
}

export interface MergePreviewView {
  readonly kind: 'preview'
  readonly survivor: CustomerMergeSubject
  readonly loser: CustomerMergeSubject
  readonly scorePerMille: number
  readonly phoneAgreement: string
  readonly labelAgreement: string
  readonly authority: string
  readonly tables: readonly PreviewTableView[]
  readonly consent: readonly PreviewConsentView[]
  readonly fields: readonly CustomerMergeFieldPlan[]
  readonly wouldWrite: {
    readonly mergeRecords: number
    readonly mergeRecordTables: number
    readonly auditEvents: number
  }
  readonly swapHref: string
  readonly queueHref: string
  readonly atIso: string
  readonly direction: RenderDirection
  /** True when the survivor on this page is not the plan's default. Printed, so the override is visible. */
  readonly survivorWasNominated: boolean
}

export interface MergedAwayView {
  readonly kind: 'already_merged'
  readonly mergeRecordId: string
  readonly survivorCustomerId: string
  readonly loserCustomerId: string
  readonly mergedAtIso: string
  readonly queueHref: string
  readonly direction: RenderDirection
}

export type PreviewView = MergePreviewView | MergedAwayView

const PREVIEW_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    padding: var(--space-7) var(--gutter);
    background: var(--color-ground);
    color: var(--color-ink);
    font: 1rem/1.55 system-ui, sans-serif;
  }
  main { max-width: 72rem; margin: 0 auto; }
  h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 var(--space-3); }
  h2 { font-size: 1.125rem; margin: 0 0 var(--space-3); }
  p { margin: 0 0 var(--space-5); max-width: 46rem; }
  section {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-2);
    background: var(--color-surface);
    padding: var(--space-5);
    margin: 0 0 var(--space-7);
  }
  section.lede { border-inline-start-width: var(--space-2); border-inline-start-color: var(--color-accent-gold); }
  section.confirm { border-inline-start-width: var(--space-2); border-inline-start-color: var(--color-danger); }
  .pair { display: grid; gap: var(--space-5); }
  .record {
    border: 1px solid var(--color-hairline);
    border-radius: var(--radius-2);
    background: var(--color-ground);
    padding: var(--space-5);
  }
  .record h3 { font-size: 1rem; margin: 0 0 var(--space-2); }
  dl.facts { display: grid; grid-template-columns: auto 1fr; gap: var(--space-2) var(--space-5); margin: 0; }
  dl.facts dt { color: var(--color-ink-2); }
  dl.facts dd { margin: 0; }
  table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
  caption { text-align: start; color: var(--color-ink-2); font-size: 0.875rem; padding-bottom: var(--space-3); }
  th, td { border-bottom: 1px solid var(--color-hairline); padding: var(--space-3); text-align: start; }
  th { font-size: 0.875rem; color: var(--color-ink-2); }
  td.n { text-align: end; }
  .wrap { overflow-x: auto; }
  label { display: block; font-weight: 600; margin: 0 0 var(--space-2); }
  input[type="text"], textarea {
    width: 100%;
    min-height: 48px;
    padding: var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-2);
    background: var(--color-ground);
    color: var(--color-ink);
    font: inherit;
  }
  textarea { min-height: 6rem; }
  button, a.action {
    display: inline-flex;
    align-items: center;
    min-height: 48px;
    padding: var(--space-3) var(--space-5);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-2);
    background: var(--color-surface-sand);
    color: var(--color-ink);
    text-decoration: none;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  button:focus-visible, a.action:focus-visible, input:focus-visible, textarea:focus-visible {
    outline: 3px solid var(--color-accent-teal);
    outline-offset: 2px;
  }
  .field { margin: 0 0 var(--space-5); }
  @media (min-width: 48rem) { .pair { grid-template-columns: 1fr 1fr; } }
`

const HEAD = (title: string, direction: RenderDirection): readonly string[] => [
  '<!doctype html>',
  `<html lang="en" dir="${direction}">`,
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<meta name="robots" content="noindex, nofollow, noarchive">',
  // No brand in the title, for the reason the queue's render states.
  `<title>${safeText(title)} — admin</title>`,
  `<style>${tokensCss()}${PREVIEW_CSS}</style>`,
  '</head>',
  '<body>',
  '<main>',
]

const record = (subject: CustomerMergeSubject, role: 'survivor' | 'loser'): string =>
  [
    `<div class="record" data-role="${role}">`,
    `<h3>${role === 'survivor' ? 'Kept' : 'Merged away'}</h3>`,
    '<dl class="facts">',
    `<dt>Label</dt><dd data-field="label">${safeText(subject.displayName ?? 'no label recorded')}</dd>`,
    `<dt>Number</dt><dd data-field="phone">${safeText(subject.phoneE164)}</dd>`,
    `<dt>Created</dt><dd data-field="created">${safeText(
      new Date(subject.createdAt).toISOString(),
    )}</dd>`,
    `<dt>Record</dt><dd><code data-field="id">${safeText(subject.id)}</code></dd>`,
    '</dl>',
    '</div>',
  ].join('')

const tableRows = (view: MergePreviewView): string =>
  view.tables
    .map((table) =>
      [
        `<tr data-participant="${safeText(table.participant)}">`,
        `<td><code>${safeText(table.participant)}</code></td>`,
        `<td>${safeText(table.strategy)}</td>`,
        `<td class="n" data-field="moved">${table.rowsMoved}</td>`,
        `<td class="n" data-field="inserted">${table.rowsInserted}</td>`,
        `<td class="n" data-field="retained">${table.rowsRetainedOnLoser}</td>`,
        `<td class="n">${table.rowsBeforeSurvivor} &rarr; ${table.rowsAfterSurvivor}</td>`,
        `<td class="n">${table.rowsBeforeLoser} &rarr; ${table.rowsAfterLoser}</td>`,
        `<td>${safeText(table.retainedReason ?? '')}</td>`,
        '</tr>',
      ].join(''),
    )
    .join('')

const consentRows = (view: MergePreviewView): string =>
  view.consent
    .map((row) =>
      [
        `<tr data-consent="${safeText(`${row.channel}/${row.purpose}`)}">`,
        `<td>${safeText(row.channel)}</td>`,
        `<td>${safeText(row.purpose)}</td>`,
        `<td data-field="before">${safeText(row.before)}</td>`,
        `<td data-field="after">${safeText(row.after)}</td>`,
        '</tr>',
      ].join(''),
    )
    .join('')

const fieldRows = (view: MergePreviewView): string =>
  view.fields
    .map((field) =>
      [
        `<tr data-plan-field="${safeText(field.field)}">`,
        `<td>${safeText(field.field)}</td>`,
        `<td data-field="resolution">${safeText(field.resolution)}</td>`,
        `<td>${safeText(field.survivorValue ?? '')}</td>`,
        `<td>${safeText(field.loserValue ?? '')}</td>`,
        `<td>${safeText(field.why ?? '')}</td>`,
        '</tr>',
      ].join(''),
    )
    .join('')

function renderPreview(view: MergePreviewView): string {
  return [
    ...HEAD('Merge preview', view.direction),
    '<h1>Merge preview</h1>',
    '<section class="lede">',
    '<p><strong>Nothing has been merged.</strong> Every figure below was produced by running the real ' +
      'merge inside a transaction that was rolled back, so it is what the merge did and then undid — not ' +
      'a description of what it would do. The two cannot disagree, because they are the same code.</p>',
    `<p>Score <strong data-field="score">${(view.scorePerMille / 1000).toFixed(3)}</strong> ` +
      `(${view.scorePerMille} per mille) — number <strong data-field="phone-agreement">` +
      `${safeText(view.phoneAgreement)}</strong>, label <strong data-field="label-agreement">` +
      `${safeText(view.labelAgreement)}</strong>. Authority ` +
      `<code data-field="authority">${safeText(view.authority)}</code>.</p>`,
    `<p>Consent is resolved as at <code data-field="at">${safeText(view.atIso)}</code>. ` +
      `<a href="${safeText(view.queueHref)}">Back to the queue</a>.</p>`,
    '</section>',
    '<section aria-labelledby="pair-heading">',
    '<h2 id="pair-heading">Which record survives</h2>',
    view.survivorWasNominated
      ? '<p data-field="nomination">The survivor on this page was <strong>chosen by hand</strong> rather ' +
        'than taken as the default. The default is the earlier record, because the longer history hangs ' +
        'off it.</p>'
      : '<p data-field="nomination">This is the <strong>default</strong> survivor: the earlier of the two ' +
        'records, because its bookings, invoices and clinical file are the longer history.</p>',
    `<div class="pair">${record(view.survivor, 'survivor')}${record(view.loser, 'loser')}</div>`,
    `<p><a class="action" data-action="swap" href="${safeText(view.swapHref)}">Keep the other record ` +
      'instead</a></p>',
    '</section>',
    '<section aria-labelledby="tables-heading">',
    '<h2 id="tables-heading">What would move</h2>',
    // `tabindex="0"` because the table scrolls sideways on a phone: axe's
    // `scrollable-region-focusable` is a serious violation for a scrollable region a keyboard
    // cannot reach, and it fired on all three of these at 390px on this unit's first run. The
    // label is the section's own heading, so the stop a keyboard lands on says what it is.
    `<div class="wrap" tabindex="0" role="group" aria-labelledby="tables-heading">`,
    '<table>',
    '<caption>One row per registered merge participant. A row retained on the merged-away record stays ' +
      'readable there and states why it did not move.</caption>',
    '<thead><tr><th>Table</th><th>Strategy</th><th>Moved</th><th>Copied</th><th>Retained</th>' +
      '<th>Kept record</th><th>Merged-away record</th><th>Why retained</th></tr></thead>',
    `<tbody>${tableRows(view)}</tbody>`,
    '</table>',
    '</div>',
    `<p>Were this authorised it would write <span data-field="would-write">` +
      `${view.wouldWrite.mergeRecords}</span> merge record, ` +
      `${view.wouldWrite.mergeRecordTables} per-table reports and ` +
      `${view.wouldWrite.auditEvents} audit row.</p>`,
    '</section>',
    '<section aria-labelledby="consent-heading">',
    '<h2 id="consent-heading">Consent, before and after</h2>',
    '<p>Folded by the same resolver the send path reads through. A withdrawal on either record governs ' +
      'the survivor when it is the newest thing either of them said, and a merge never manufactures one.</p>',
    // `tabindex="0"` because the table scrolls sideways on a phone: axe's
    // `scrollable-region-focusable` is a serious violation for a scrollable region a keyboard
    // cannot reach, and it fired on all three of these at 390px on this unit's first run. The
    // label is the section's own heading, so the stop a keyboard lands on says what it is.
    `<div class="wrap" tabindex="0" role="group" aria-labelledby="consent-heading">`,
    '<table>',
    '<caption>The kept record’s consent state, as it stands and as this merge would leave it.</caption>',
    '<thead><tr><th>Channel</th><th>Purpose</th><th>Now</th><th>After the merge</th></tr></thead>',
    `<tbody>${consentRows(view)}</tbody>`,
    '</table>',
    '</div>',
    '</section>',
    '<section aria-labelledby="fields-heading">',
    '<h2 id="fields-heading">What each field resolves to</h2>',
    // `tabindex="0"` because the table scrolls sideways on a phone: axe's
    // `scrollable-region-focusable` is a serious violation for a scrollable region a keyboard
    // cannot reach, and it fired on all three of these at 390px on this unit's first run. The
    // label is the section's own heading, so the stop a keyboard lands on says what it is.
    `<div class="wrap" tabindex="0" role="group" aria-labelledby="fields-heading">`,
    '<table>',
    '<caption>A field neither record disagrees about is <code>agreed</code>. A value the column cannot ' +
      'hold at all is <code>not_transferable</code>, with the reason.</caption>',
    '<thead><tr><th>Field</th><th>Resolution</th><th>Kept</th><th>Merged away</th><th>Why</th></tr></thead>',
    `<tbody>${fieldRows(view)}</tbody>`,
    '</table>',
    '</div>',
    '</section>',
    '<section class="confirm" aria-labelledby="confirm-heading">',
    '<h2 id="confirm-heading">Authorise this merge</h2>',
    '<p>A merge cannot be undone by a delete: the rows have moved and the append-only ones have been ' +
      'copied. Both fields below are stored on the merge record, and the database refuses a placeholder ' +
      'in either.</p>',
    '<form method="post" action="/clients/duplicates/preview">',
    `<input type="hidden" name="survivor" value="${safeText(view.survivor.id)}">`,
    `<input type="hidden" name="loser" value="${safeText(view.loser.id)}">`,
    `<input type="hidden" name="dir" value="${view.direction}">`,
    '<div class="field">',
    '<label for="authorisedBy">Who is authorising this (role or desk, as it should read on the record)</label>',
    '<input type="text" id="authorisedBy" name="authorisedBy" required maxlength="200" autocomplete="off">',
    '</div>',
    '<div class="field">',
    '<label for="reason">Why these are one person</label>',
    '<textarea id="reason" name="reason" required maxlength="1000"></textarea>',
    '</div>',
    '<button type="submit" name="confirm" value="yes">Merge these records</button>',
    '</form>',
    '</section>',
    '</main>',
    '</body>',
    '</html>',
  ].join('\n')
}

function renderMergedAway(view: MergedAwayView): string {
  return [
    ...HEAD('Already merged', view.direction),
    '<h1>Already merged</h1>',
    '<section class="lede">',
    '<p>This pair has been merged. A merge is recorded once per merged-away record — that unique row IS ' +
      'the tombstone — so a repeated attempt changes nothing and reports itself rather than doing the ' +
      'work again.</p>',
    '<dl class="facts">',
    `<dt>Merge record</dt><dd><code data-field="merge-record">${safeText(
      view.mergeRecordId,
    )}</code></dd>`,
    `<dt>Kept</dt><dd><code data-field="survivor">${safeText(view.survivorCustomerId)}</code></dd>`,
    `<dt>Merged away</dt><dd><code data-field="loser">${safeText(view.loserCustomerId)}</code></dd>`,
    `<dt>Merged at</dt><dd data-field="merged-at">${safeText(view.mergedAtIso)}</dd>`,
    '</dl>',
    `<p><a class="action" href="${safeText(view.queueHref)}">Back to the queue</a></p>`,
    '</section>',
    '</main>',
    '</body>',
    '</html>',
  ].join('\n')
}

export function renderMergePreviewHtml(view: PreviewView): string {
  return view.kind === 'preview' ? renderPreview(view) : renderMergedAway(view)
}

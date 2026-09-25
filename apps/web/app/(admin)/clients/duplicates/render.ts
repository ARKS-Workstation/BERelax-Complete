import type { DuplicateQueue, DuplicateQueueRow } from '@berelax/core'
import { safeText } from '@berelax/core'
import { tokensCss } from '@berelax/ui'

/**
 * The duplicate review queue, as HTML (C-CRM-06).
 *
 * Pure: a queue in, a document out. No database, no clock — every figure on the page is a function of the
 * rows it is given, which is what lets `apps/web/src/duplicates-render.test.ts` assert the screen without a
 * server and what makes two consecutive renders of one queue identical.
 *
 * ## What this screen is for, and the one thing it must never do
 *
 * The provisional line on this unit is that there is **no unattended auto-merge in the first release, even
 * above the 0.95 threshold — every merge is confirmed by a named human**. So the queue offers no merge
 * button. Each row links to the preview, and the preview is where a person authorises one. The page says
 * that on its face, because a reviewer who believes the queue merges things will click accordingly.
 *
 * ## Why the counts are on the page
 *
 * A filter over a search has an empty answer for several different reasons, and they have different
 * remedies: nothing found at all (the scan is misconfigured or the table is small), everything found was
 * below the review threshold (normal — C-CRM-02's floors are deliberately looser than the scorer's), or
 * everything found was already merged (normal, and the point of the tombstone filter). A screen that
 * printed "nothing to review" for all three would be hiding the only one worth acting on.
 *
 * The probe bound is printed for the same reason. The scan is one query per record and the queue reads the
 * newest records first, so a queue over a big table is a queue over a window — and a window nobody
 * mentions reads as a guarantee.
 *
 * ## Why a route handler and not a page
 *
 * The reason the template editor and the Messages inbox give: W-SITE-01's registry requires every
 * *document* to be served in both locales, so a `page.tsx` here would need an Arabic admin document and the
 * W-SYS-01 shell. `?dir=rtl` re-renders this English document mirrored, which is a layout axis rather than
 * a locale: it is how the direction half of the accessibility matrix is audited without inventing an
 * Arabic admin surface. **Not authenticated**, exactly as every route under `/compliance`, `/hr` and
 * `/settings` records.
 */

export type RenderDirection = 'ltr' | 'rtl'

/** What every link between these two screens has to carry, so a narrowed view stays narrowed. */
export interface ScopeLink {
  /** The ids the request narrowed to, or null for the whole (bounded) window. */
  readonly customerIds: readonly string[] | null
  /** The instant every consent state on the preview is resolved at, as the request asked for it. */
  readonly atIso: string
  readonly direction: RenderDirection
}

export interface QueueScopeView extends ScopeLink {
  readonly recordsProbed: number
  readonly scansIssued: number
  readonly bounded: boolean
  readonly subjectLimit: number
}

export interface DuplicateQueueView {
  readonly queue: DuplicateQueue
  readonly scope: QueueScopeView
  /** The review threshold in force, in per mille, so the page states the band it filtered on. */
  readonly reviewPerMille: number
  readonly autoMergePerMille: number
  readonly thresholdsOpenQuestion: string
}

/** The page's own styles. Colours are tokens only; there is no literal in this file. */
const QUEUE_CSS = `
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
  h2 { font-size: 1.125rem; margin: 0 0 var(--space-3); }
  p { margin: 0 0 var(--space-5); max-width: 46rem; }
  .lede, .counts {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-2);
    background: var(--color-surface);
    padding: var(--space-5);
    margin: 0 0 var(--space-7);
  }
  .lede { border-inline-start-width: var(--space-2); border-inline-start-color: var(--color-accent-gold); }
  .count { font-variant-numeric: tabular-nums; font-weight: 600; }
  dl.tally { display: grid; grid-template-columns: 1fr auto; gap: var(--space-2) var(--space-5); margin: 0; }
  dl.tally dt { color: var(--color-ink-2); }
  dl.tally dd { margin: 0; text-align: end; font-variant-numeric: tabular-nums; }
  ol.rows { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-5); }
  ol.rows > li > article {
    border: 1px solid var(--color-hairline);
    border-radius: var(--radius-2);
    background: var(--color-surface);
    padding: var(--space-5);
  }
  .score { font-size: 1.25rem; font-weight: 700; font-variant-numeric: tabular-nums; }
  .verdict { color: var(--color-ink-2); }
  .pair { display: grid; gap: var(--space-5); margin: var(--space-5) 0; }
  .record {
    border: 1px solid var(--color-hairline);
    border-radius: var(--radius-2);
    background: var(--color-ground);
    padding: var(--space-5);
  }
  .record h3 { font-size: 1rem; margin: 0 0 var(--space-2); }
  .record dl { display: grid; grid-template-columns: auto 1fr; gap: var(--space-2) var(--space-5); margin: 0; }
  .record dt { color: var(--color-ink-2); }
  .record dd { margin: 0; }
  .signals { color: var(--color-ink-2); margin: 0 0 var(--space-5); }
  a.action {
    display: inline-flex;
    align-items: center;
    min-height: 48px;
    padding: var(--space-3) var(--space-5);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-2);
    background: var(--color-surface-sand);
    color: var(--color-ink);
    text-decoration: none;
    font-weight: 600;
  }
  a.action:focus-visible { outline: 3px solid var(--color-accent-teal); outline-offset: 2px; }
  .empty { border-inline-start-color: var(--color-accent-teal); }
  @media (min-width: 48rem) { .pair { grid-template-columns: 1fr 1fr; } }
`

const SCORE = (perMille: number): string => (perMille / 1000).toFixed(3)

/** The scope, carried onto every link so a narrowed queue stays narrowed. */
export function scopeQuery(scope: ScopeLink): string {
  const parts: string[] = [`at=${encodeURIComponent(scope.atIso)}`]
  if (scope.direction === 'rtl') parts.push('dir=rtl')
  for (const id of scope.customerIds ?? []) parts.push(`customer=${encodeURIComponent(id)}`)
  return parts.join('&')
}

/** The preview URL for one row, with the survivor named EXPLICITLY even when it is the default. */
export function previewHref(row: DuplicateQueueRow, scope: ScopeLink): string {
  return (
    `/clients/duplicates/preview?survivor=${encodeURIComponent(row.survivor.id)}` +
    `&loser=${encodeURIComponent(row.loser.id)}&${scopeQuery(scope)}`
  )
}

const recordCard = (
  heading: string,
  record: DuplicateQueueRow['survivor'],
  role: 'survivor' | 'loser',
): string =>
  [
    `<div class="record" data-role="${role}">`,
    `<h3>${safeText(heading)}</h3>`,
    '<dl>',
    // The label, and never a name: a record with no display name is labelled by its number (ADR 0020),
    // and this column holds whatever the front desk typed.
    `<dt>Label</dt><dd data-field="label">${safeText(record.displayName ?? 'no label recorded')}</dd>`,
    `<dt>Number</dt><dd data-field="phone">${safeText(record.phoneE164)}</dd>`,
    `<dt>Created</dt><dd data-field="created">${safeText(
      new Date(record.createdAt).toISOString(),
    )}</dd>`,
    `<dt>Created via</dt><dd data-field="created-via">${safeText(record.createdVia)}</dd>`,
    `<dt>Record</dt><dd><code data-field="id">${safeText(record.id)}</code></dd>`,
    '</dl>',
    '</div>',
  ].join('')

const rowArticle = (row: DuplicateQueueRow, scope: QueueScopeView): string =>
  [
    `<li><article data-pair="${safeText(row.pairKey)}">`,
    `<p><span class="score" data-field="score">${SCORE(row.scorePerMille)}</span> `,
    `<span class="verdict">(${safeText(row.scorePerMille.toString())} per mille, `,
    `verdict <strong data-field="verdict">${safeText(row.verdict)}</strong>)</span></p>`,
    '<p class="signals">Matched on: number <strong data-field="phone-agreement">' +
      `${safeText(row.phoneAgreement)}</strong>, label <strong data-field="label-agreement">` +
      `${safeText(row.labelAgreement)}</strong>.</p>`,
    '<div class="pair">',
    recordCard('Would be kept (default)', row.survivor, 'survivor'),
    recordCard('Would be merged away', row.loser, 'loser'),
    '</div>',
    `<p><a class="action" href="${safeText(previewHref(row, scope))}">Preview this merge</a></p>`,
    '</article></li>',
  ].join('')

const tally = (view: DuplicateQueueView): string => {
  const { excluded, pairsConsidered } = view.queue
  const rows: readonly [string, number | string][] = [
    ['Pairs the scan found', pairsConsidered],
    ['In the queue', view.queue.rows.length],
    ['Below the review threshold', excluded.below_review_threshold],
    ['Already merged away', excluded.merged_away],
    ['Same record', excluded.same_record],
    ['Record not loaded', excluded.record_not_loaded],
    ['Refused by the merge plan', excluded.plan_refused],
    ['Records probed', view.scope.recordsProbed],
    ['Candidate scans issued', view.scope.scansIssued],
  ]
  return [
    '<section class="counts" aria-labelledby="tally-heading">',
    '<h2 id="tally-heading">What the scan found</h2>',
    '<dl class="tally">',
    ...rows.map(
      ([label, value]) => `<dt>${safeText(label)}</dt><dd>${safeText(String(value))}</dd>`,
    ),
    '</dl>',
    view.scope.bounded
      ? `<p><strong>This is a window, not the whole table.</strong> The newest ${safeText(
          String(view.scope.subjectLimit),
        )} records were probed, so a duplicate older than that window is not on this page.</p>`
      : '<p>Every record in scope was probed.</p>',
    view.queue.refusals.length === 0
      ? ''
      : `<p>Plan refusals seen: <code>${safeText(view.queue.refusals.join(', '))}</code>.</p>`,
    '</section>',
  ].join('')
}

export function renderDuplicateQueueHtml(view: DuplicateQueueView): string {
  const { scope } = view
  return [
    '<!doctype html>',
    `<html lang="en" dir="${scope.direction}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    // No brand in the title: `apps/web/src/seo/brand.test.ts` requires the full trading name wherever the
    // brand appears, and an internal review queue naming it would be citing the wrong entity. The rule is
    // about how the brand is written, so not writing it is compliant.
    '<title>Duplicate review queue — admin</title>',
    `<style>${tokensCss()}${QUEUE_CSS}</style>`,
    '</head>',
    '<body>',
    '<main>',
    '<h1>Duplicate review queue</h1>',
    '<div class="lede">',
    '<p><strong>Nothing on this page merges anything.</strong> Every row links to a preview, and the ' +
      'preview is where a merge is authorised by somebody who has read it. There is no unattended ' +
      'auto-merge in this release, even above the auto band: a false merge cannot be undone by a delete ' +
      '— the rows have moved and the append-only ones have been copied — so a person confirms each one.</p>',
    `<p>Pairs scoring at least <span class="count">${SCORE(view.reviewPerMille)}</span> are listed. ` +
      `The auto band starts at <span class="count">${SCORE(view.autoMergePerMille)}</span> and is ` +
      'listed here too, unmerged, for the same reason. Both figures are provisional and are tracked as ' +
      `<code>${safeText(view.thresholdsOpenQuestion)}</code>.</p>`,
    `<p>Consent states on the preview are resolved as at <code data-field="at">${safeText(
      scope.atIso,
    )}</code>.</p>`,
    '</div>',
    tally(view),
    view.queue.rows.length === 0
      ? '<section class="lede empty"><h2>Nothing to review</h2><p>No pair in scope is above the ' +
        'review threshold. The counts above say which of the three reasons that is: no candidate pairs ' +
        'at all, every pair below the band, or every pair already merged.</p></section>'
      : `<ol class="rows">${view.queue.rows.map((row) => rowArticle(row, scope)).join('')}</ol>`,
    '</main>',
    '</body>',
    '</html>',
  ].join('\n')
}

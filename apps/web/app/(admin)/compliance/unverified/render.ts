import { safeText } from '@berelax/core'
import { tokensCss } from '@berelax/ui'

/**
 * The open-compliance-questions dashboard (M-VAT-11, docs/04 §9).
 *
 * *"An open-compliance-questions dashboard is driven by the `[UNVERIFIED]` flags in the obligation table,
 * so unresolved legal questions stay visible in the product instead of being lost in a document like this
 * one."*
 *
 * Pure: rows in, a document out, no database and no clock.
 *
 * ## The distinction this screen exists to make
 *
 * Three sections, each with its own count and its own remedy:
 *
 *   1. **Unconfirmed duties.** `obligation.is_unverified`: this build's reading of a secondary source,
 *      with the `OPEN-QUESTIONS` id of the question that would settle it and the note saying which part
 *      is unanswered. The remedy is a lawyer or a letter to the authority.
 *   2. **Confirmed duties with no deadline on file.** The duty is real and nobody has read a renewal date
 *      off the document, so the calendar generates nothing for it. The remedy is somebody opening the
 *      licence and typing the date in.
 *   3. **Overdue.** A dated occurrence, open, past its due date. The remedy is a renewal.
 *
 * Conflating the second with the third is the specific failure this unit is judged on. They read the same
 * on a naive dashboard — six red rows — and they are not the same fact: a blank nobody has filled in is
 * not a deadline anybody has missed. A screen that showed them together would report six breaches on a
 * calendar where nothing is overdue at all, and after a fortnight of that the real one is invisible.
 *
 * Section 1 is INDEPENDENT of the other two, deliberately, and it is the one place a row may appear twice.
 * An unconfirmed duty for which somebody has nevertheless entered a real renewal date that has since
 * lapsed is a genuine breach AND an open legal question, and the two have different answers. Dropping it
 * from section 3 would hide the breach behind the question; dropping it from section 1 would lose the
 * question. Sections 2 and 3 cannot both hold — an overdue occurrence IS a deadline on file — and that
 * exclusivity is `complianceQuestionRows`' and not this file's.
 */

export interface UnverifiedRow {
  readonly key: string
  readonly title: string
  readonly obligationClass: string
  readonly ownerRole: string
  readonly openQuestionId: string
  readonly unverifiedNote: string
  readonly sourceReference: string
  readonly authority: string | null
}

export interface NoDeadlineRow {
  readonly key: string
  readonly title: string
  readonly ownerRole: string
  readonly cadence: string
  readonly sourceReference: string
}

export interface OverdueRow {
  readonly key: string
  readonly title: string
  readonly dueOn: string
  readonly blockingEffect: string
  /**
   * Whether the DUTY behind this breach is also unconfirmed.
   *
   * Printed on the row rather than used to filter it out. A dated occurrence exists because somebody
   * entered a real renewal date, so a lapsed one is a lapsed licence whatever the state of the legal
   * question behind it — and dropping it from this section because the duty is unverified would hide a
   * real breach behind an unanswered question. It appears in both sections, once as a question and once
   * as a breach, which is two facts rather than one counted twice.
   */
  readonly isUnconfirmedDuty: boolean
  readonly acknowledged: boolean
}

export interface ComplianceQuestionsView {
  readonly asOf: string
  readonly unconfirmed: readonly UnverifiedRow[]
  readonly noDeadline: readonly NoDeadlineRow[]
  readonly overdue: readonly OverdueRow[]
}

const QUESTIONS_CSS = `
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
  p { margin: 0 0 var(--space-5); }
  .lede {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-2);
    background: var(--color-surface);
    padding: var(--space-5);
    margin: 0 0 var(--space-7);
  }
  section {
    border: 1px solid var(--color-border);
    border-inline-start-width: var(--space-2);
    border-radius: var(--radius-2);
    background: var(--color-surface);
    padding: var(--space-5);
    margin: 0 0 var(--space-7);
  }
  section.unconfirmed { border-inline-start-color: var(--color-accent-gold); }
  section.no-deadline { border-inline-start-color: var(--color-accent-teal); }
  section.overdue { border-inline-start-color: var(--color-danger); }
  .count { font-variant-numeric: tabular-nums; font-weight: 600; }
  ol { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-5); }
  li article {
    border: 1px solid var(--color-hairline);
    border-radius: var(--radius-2);
    background: var(--color-ground);
    padding: var(--space-5);
  }
  h3 { font-size: 1rem; margin: 0 0 var(--space-3); }
  dl { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: var(--space-2) var(--space-5); }
  dt { color: var(--color-ink-2); font-size: 0.875rem; }
  dd { margin: 0; }
  dd.note { grid-column: 1 / -1; color: var(--color-ink-2); }
  code { font-size: 0.875rem; }
  .none { color: var(--color-ink-2); margin: 0; }
  @media (max-width: 40rem) {
    dl { grid-template-columns: 1fr; gap: 0; }
    dt { margin-top: var(--space-3); }
  }
`

function unverifiedArticle(row: UnverifiedRow): string {
  return (
    '<li><article>' +
    `<h3><code>${safeText(row.key)}</code> — ${safeText(row.title)}</h3>` +
    '<dl>' +
    `<dt>Open question</dt><dd><code>${safeText(row.openQuestionId)}</code></dd>` +
    `<dt>Owed by</dt><dd>${safeText(row.ownerRole)}</dd>` +
    `<dt>Authority</dt><dd>${row.authority === null ? 'not stated — nobody has told the build which body it is' : safeText(row.authority)}</dd>` +
    `<dt>Source</dt><dd>${safeText(row.sourceReference)}</dd>` +
    `<dd class="note">${safeText(row.unverifiedNote)}</dd>` +
    '</dl>' +
    '</article></li>'
  )
}

function noDeadlineArticle(row: NoDeadlineRow): string {
  return (
    '<li><article>' +
    `<h3><code>${safeText(row.key)}</code> — ${safeText(row.title)}</h3>` +
    '<dl>' +
    `<dt>Owed by</dt><dd>${safeText(row.ownerRole)}</dd>` +
    `<dt>Cadence</dt><dd>${safeText(row.cadence)}</dd>` +
    `<dt>Source</dt><dd>${safeText(row.sourceReference)}</dd>` +
    '<dd class="note">The duty is confirmed and no first due date has been read off the document, so ' +
    'the calendar generates no occurrence and nothing can be overdue. This is not a breach: it is a ' +
    'blank, and a blank is visibly unanswered where a plausible date would read as configured.</dd>' +
    '</dl>' +
    '</article></li>'
  )
}

function overdueArticle(row: OverdueRow): string {
  return (
    '<li><article>' +
    `<h3><code>${safeText(row.key)}</code> — ${safeText(row.title)}</h3>` +
    '<dl>' +
    `<dt>Was due</dt><dd>${safeText(row.dueOn)}</dd>` +
    `<dt>Consequence</dt><dd>${
      row.blockingEffect === 'none'
        ? 'none — overdue and not blocking'
        : safeText(row.blockingEffect.replaceAll('_', ' '))
    }</dd>` +
    `<dt>Acknowledged</dt><dd>${row.acknowledged ? 'yes — escalation stopped' : 'no — still escalating'}</dd>` +
    `<dt>Duty</dt><dd>${
      row.isUnconfirmedDuty
        ? 'unconfirmed — this breach is a date somebody entered against a duty nobody has confirmed, and it is listed above as a question as well'
        : 'confirmed'
    }</dd>` +
    '</dl>' +
    '</article></li>'
  )
}

export function renderComplianceQuestionsHtml(view: ComplianceQuestionsView): string {
  return [
    '<!doctype html>',
    '<html lang="en" dir="ltr">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    '<title>Open compliance questions — admin</title>',
    `<style>${tokensCss()}${QUESTIONS_CSS}</style>`,
    '</head>',
    '<body>',
    '<main>',
    '<h1>Open compliance questions</h1>',
    '<div class="lede">',
    `<p><strong>Judged against ${safeText(view.asOf)}</strong> — the trading date while the premises is ` +
      'open, and the calendar date in the daytime gap. This page separates ' +
      'three things that look alike and are not: a duty nobody has confirmed, a confirmed duty with no ' +
      'deadline on file, and a deadline that has passed. Adding them together would report every ' +
      'unanswered question as a breach — and a screen that cries wolf about six of them is a screen ' +
      'nobody reads on the day one is real.</p>',
    `<p>Back to the <a href="/compliance">compliance calendar</a>.</p>`,
    '</div>',

    '<section class="unconfirmed">',
    `<h2>Unconfirmed duties: <span class="count">${view.unconfirmed.length}</span></h2>`,
    '<p>This build’s reading of a secondary source, not a confirmed legal obligation. Each names the ' +
      'question in <code>docs/OPEN-QUESTIONS.md</code> that would settle it. <strong>None of these is ' +
      'overdue</strong>: nobody has confirmed there is a deadline to miss.</p>',
    view.unconfirmed.length === 0
      ? '<p class="none">None. Every obligation in the calendar is a duty somebody has confirmed.</p>'
      : `<ol>${view.unconfirmed.map(unverifiedArticle).join('')}</ol>`,
    '</section>',

    '<section class="no-deadline">',
    `<h2>Confirmed, no deadline on file: <span class="count">${view.noDeadline.length}</span></h2>`,
    '<p>The duty is real and the first due date is blank, so the calendar generates nothing for it. The ' +
      'answer is on a licence, a permit or a certificate that the build has not seen.</p>',
    view.noDeadline.length === 0
      ? '<p class="none">None. Every confirmed obligation has a first due date on file.</p>'
      : `<ol>${view.noDeadline.map(noDeadlineArticle).join('')}</ol>`,
    '</section>',

    '<section class="overdue">',
    `<h2>Overdue: <span class="count">${view.overdue.length}</span></h2>`,
    '<p>A dated occurrence, open, past its due date. This is the only section that reports a breach, and ' +
      'the remedy is a renewal rather than an answer. An occurrence exists because somebody entered a ' +
      'real date, so a lapsed one is listed here whether or not the duty behind it is confirmed.</p>',
    view.overdue.length === 0
      ? '<p class="none">None. Nothing dated has passed its due date.</p>'
      : `<ol>${view.overdue.map(overdueArticle).join('')}</ol>`,
    '</section>',

    '</main>',
    '</body>',
    '</html>',
  ].join('')
}

import { safeText } from '@berelax/core'
import { tokensCss } from '@berelax/ui'

/**
 * The compliance calendar, as HTML (M-VAT-11, docs/04 §9).
 *
 * Pure: rows in, a document out, no database and no clock. The as-of date arrives in the view and is
 * printed on the page, which is the same rule the HR credentials screen next door follows — a screen that
 * said "as of now" could not produce two identical screenshots on a repeat run, and could not be asked
 * "what did this look like on the 31st".
 *
 * ## Why this is a document served by a route handler and not a `page.tsx`
 *
 * `apps/web/src/routes/registry.ts` is in exact bijection with the filesystem and requires every
 * **document** to be served in both locales, so a `page.tsx` here would need an Arabic admin document and
 * the admin shell W-SYS-01 has not built, and it would join a screenshot matrix whose RTL half must be a
 * real Arabic route. The Messages inbox, the breakpoint preview and the credentials screen are the three
 * precedents. This surface is English-only on purpose.
 *
 * ## The banner, and the one thing it must not say
 *
 * docs/04 §9 asks that "the owner sees a banner" when a blocking obligation is overdue, and the banner is
 * the first thing on the page when there is one. What it must never do is count an UNANSWERED QUESTION as
 * a breach. "Nobody has confirmed that this duty exists" and "this duty is overdue" are different facts
 * with different remedies — the first is answered by a lawyer and the second by a renewal — and a banner
 * that added them together would show a red count of six on a calendar where nothing is overdue at all.
 * After a fortnight of that nobody reads the banner, which is the failure mode that makes a compliance
 * screen worse than none. The two counts are therefore rendered separately and the unconfirmed one links
 * to its own screen.
 *
 * ## What it must never show
 *
 * A licence number, a permit number or a TRN. None is on file (Y1-licence, Y1-trn), the obligation table
 * holds none, and this page prints the obligation KEY and its authority instead. Nor a storage key: an
 * evidence file is named by the first twelve characters of its content hash, which is enough to tell two
 * attachments apart and is not a path into the private bucket.
 */

/** One obligation, as the calendar shows it. */
export interface CalendarObligationRow {
  readonly key: string
  readonly title: string
  readonly obligationClass: string
  readonly cadence: string
  readonly ownerRole: string
  readonly escalationRole: string | null
  readonly blockingEffect: string
  readonly evidenceRequired: boolean
  readonly isUnverified: boolean
  readonly authority: string | null
  readonly sourceReference: string
  /** The first due date on file, or null when nobody has read one off the document. */
  readonly anchorOn: string | null
}

/** One dated occurrence, with the notices planned against it. */
export interface CalendarOccurrenceRow {
  readonly instanceId: string
  readonly obligationKey: string
  readonly dueOn: string
  readonly status: 'open' | 'completed'
  readonly overdue: boolean
  readonly acknowledged: boolean
  readonly blockingEffect: string
  readonly notices: readonly CalendarNoticeRow[]
  /** The evidence filed against it, by content hash. Never a storage key. */
  readonly evidence: readonly { readonly evidenceId: string; readonly contentHash: string }[]
}

export interface CalendarNoticeRow {
  readonly step: string
  readonly kind: string
  readonly toRole: string
  readonly state: string
  readonly notifyOn: string
  readonly skippedReason: string | null
}

export interface ComplianceCalendarView {
  readonly asOf: string
  readonly obligations: readonly CalendarObligationRow[]
  readonly occurrences: readonly CalendarOccurrenceRow[]
  readonly reminderOffsetsDays: readonly number[]
  readonly escalationOffsetsDays: readonly number[]
  /** How many obligations carry the unverified flag. NOT added to the overdue count. */
  readonly unconfirmedCount: number
}

const CALENDAR_CSS = `
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
  .banner-breach { border-inline-start-color: var(--color-danger); }
  .banner-question { border-inline-start-color: var(--color-accent-gold); }
  .banner-clear { border-inline-start-color: var(--color-success); }
  .banner h2 { margin: 0 0 var(--space-3); font-size: 1rem; }
  .banner p:last-child { margin-bottom: 0; }
  .policy {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-2);
    background: var(--color-surface);
    padding: var(--space-5);
    margin: 0 0 var(--space-7);
  }
  .policy ul { margin: var(--space-3) 0 0; padding-inline-start: var(--space-7); }
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
  td.date { font-variant-numeric: tabular-nums; white-space: nowrap; }
  code { font-size: 0.875rem; }
  .flag { display: inline-flex; align-items: center; gap: var(--space-3); white-space: nowrap; }
  .dot { width: var(--space-4); height: var(--space-4); border-radius: var(--radius-handle); flex: none; }
  .dot-overdue { background: var(--color-danger); }
  .dot-due { background: var(--color-accent-gold); }
  .dot-done { background: var(--color-success); }
  .dot-none { background: var(--color-ink-3); }
  ul.notices { margin: 0; padding: 0; list-style: none; font-size: 0.875rem; }
  ul.notices li { padding: 2px 0; color: var(--color-ink-2); }
  .empty {
    border: 1px dashed var(--color-border);
    border-radius: var(--radius-2);
    padding: var(--space-9) var(--space-5);
    text-align: center;
    color: var(--color-ink-2);
  }
`

/** `trade_licence_renewal` reads as a handle; `Trade licence renewal` reads as a sentence. */
function label(value: string): string {
  return value.replaceAll('_', ' ').replace(/^./, (character) => character.toUpperCase())
}

/**
 * A status cell: the word first, with the colour as a second signal and never the only one.
 *
 * A status told by colour alone cannot be read by a colour-blind operator, which docs/08 treats as a
 * defect — and on this screen it would be the difference between "overdue" and "due", which is the whole
 * message.
 */
function statusCell(occurrence: CalendarOccurrenceRow): string {
  const [dot, word] =
    occurrence.status === 'completed'
      ? ['dot-done', 'completed']
      : occurrence.overdue
        ? ['dot-overdue', 'overdue']
        : ['dot-due', 'open']
  return (
    `<span class="flag"><span class="dot ${dot}" aria-hidden="true"></span>${safeText(word)}` +
    `${occurrence.acknowledged ? ', acknowledged' : ''}</span>`
  )
}

function noticeList(notices: readonly CalendarNoticeRow[]): string {
  if (notices.length === 0) {
    return '<span class="flag"><span class="dot dot-none" aria-hidden="true"></span>none planned</span>'
  }
  return `<ul class="notices">${notices
    .map(
      (notice) =>
        `<li>${safeText(notice.step)} &rarr; ${safeText(notice.toRole)}, ${safeText(notice.notifyOn)}: ` +
        `${safeText(notice.state)}${notice.skippedReason === null ? '' : ` (${safeText(notice.skippedReason)})`}</li>`,
    )
    .join('')}</ul>`
}

function obligationRow(row: CalendarObligationRow): string {
  const deadline =
    row.anchorOn === null
      ? '<span class="flag"><span class="dot dot-none" aria-hidden="true"></span>no deadline on file</span>'
      : `<span class="date">${safeText(row.anchorOn)}</span>`
  return (
    '<tr>' +
    `<th scope="row"><code>${safeText(row.key)}</code><br>${safeText(row.title)}</th>` +
    `<td>${safeText(label(row.obligationClass))}, ${safeText(row.cadence)}</td>` +
    `<td>${safeText(row.ownerRole)}${
      row.escalationRole === null
        ? ' <em>(no role above)</em>'
        : ` &rarr; ${safeText(row.escalationRole)}`
    }</td>` +
    `<td>${row.blockingEffect === 'none' ? 'none' : safeText(label(row.blockingEffect))}</td>` +
    `<td>${row.evidenceRequired ? 'required' : 'not required'}</td>` +
    `<td class="date">${deadline}</td>` +
    `<td>${row.authority === null ? '—' : safeText(row.authority)}</td>` +
    `<td>${row.isUnverified ? 'unconfirmed duty' : 'confirmed'}</td>` +
    '</tr>'
  )
}

function occurrenceRow(row: CalendarOccurrenceRow): string {
  const evidence =
    row.evidence.length === 0
      ? 'none filed'
      : row.evidence
          // The first twelve characters of the content hash: enough to tell two attachments apart, and
          // not a path into the private bucket. The bytes themselves are behind an expiring grant.
          .map((item) => `<code>${safeText(item.contentHash.slice(0, 12))}</code>`)
          .join(', ')
  return (
    '<tr>' +
    `<th scope="row"><code>${safeText(row.obligationKey)}</code></th>` +
    `<td class="date">${safeText(row.dueOn)}</td>` +
    `<td>${statusCell(row)}</td>` +
    `<td>${row.blockingEffect === 'none' ? 'non-blocking' : safeText(label(row.blockingEffect))}</td>` +
    `<td>${noticeList(row.notices)}</td>` +
    `<td>${evidence}</td>` +
    '</tr>'
  )
}

/**
 * A ladder, in the order a reader lives through it.
 *
 * `obligationNoticeOffsetsFrom` returns a canonical DESCENDING set, which is what makes two equivalent
 * settings produce identical rows — and descending is chronological for reminders (60 days before, then
 * 30, then 7) and backwards for escalations, where 7 days after a deadline comes before 21. The stored
 * order is a set; the order to read it in is a property of the screen, so it is decided here.
 */
function ladder(days: readonly number[], when: string, ascending = false): string {
  if (days.length === 0) {
    return (
      'none — the ladder is empty, which switches these notices off and changes nothing about whether ' +
      'an overdue obligation blocks'
    )
  }
  const ordered = [...days].sort((left, right) => (ascending ? left - right : right - left))
  return `${ordered.map((value) => `${value} days`).join(', ')} ${when}`
}

export function renderComplianceCalendarHtml(view: ComplianceCalendarView): string {
  const breaches = view.occurrences.filter((row) => row.overdue && row.status === 'open')
  const blockingBreaches = breaches.filter((row) => row.blockingEffect !== 'none')

  const banner =
    blockingBreaches.length === 0
      ? '<div class="banner banner-clear"><h2>Nothing blocking is overdue</h2><p>No dated occurrence ' +
        'of a blocking obligation has passed its due date. Availability and publishing are unaffected ' +
        'by this calendar today.</p></div>'
      : `<div class="banner banner-breach"><h2>${blockingBreaches.length} blocking obligation(s) ` +
        'overdue</h2><p>An overdue blocking obligation changes system behaviour: a credential breach ' +
        'takes that therapist out of bookable availability, and a licence breach refuses publishing. ' +
        `Overdue: ${blockingBreaches
          .map((row) => `${safeText(row.obligationKey)} (due ${safeText(row.dueOn)})`)
          .join(', ')}.</p></div>`

  // The second banner, and it is deliberately a SEPARATE one. Adding an unanswered question to the
  // overdue count is the conflation this screen exists not to make.
  const questions =
    view.unconfirmedCount === 0
      ? ''
      : `<div class="banner banner-question"><h2>${view.unconfirmedCount} unconfirmed ` +
        'duty(ies)</h2><p>These are this build’s reading of a secondary source and not confirmed legal ' +
        'obligations. They are <strong>not</strong> counted as overdue and they are not a breach: an ' +
        'unanswered question is answered by a lawyer, and a breach is answered by a renewal. ' +
        '<a href="/compliance/unverified">Open compliance questions</a>.</p></div>'

  const occurrences =
    view.occurrences.length === 0
      ? '<p class="empty">No occurrence has been generated. Every seeded obligation has a blank first ' +
        'due date: the build has seen no trade licence, municipality permit or therapist certificate, ' +
        'and a plausible renewal date would be indistinguishable from one read off the document. A ' +
        'blank generates nothing, which is why this list is empty rather than wrong.</p>'
      : '<table><caption>Dated occurrences, earliest first, with the notices planned against each and ' +
        'the evidence filed against it</caption><thead><tr>' +
        '<th scope="col">Obligation</th><th scope="col">Due</th><th scope="col">Status</th>' +
        '<th scope="col">If overdue</th><th scope="col">Notices</th><th scope="col">Evidence</th>' +
        `</tr></thead><tbody>${view.occurrences.map(occurrenceRow).join('')}</tbody></table>`

  return [
    '<!doctype html>',
    '<html lang="en" dir="ltr">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    // No brand in the title: docs/09's "brand collision" forbids the bare brand in any title, and an
    // internal back-office screen has no reason to name the business at all.
    '<title>Compliance calendar — admin</title>',
    `<style>${tokensCss()}${CALENDAR_CSS}</style>`,
    '</head>',
    '<body>',
    '<main>',
    '<h1>Compliance calendar</h1>',
    banner,
    questions,
    '<div class="policy">',
    // The date, and the rule that produced it — stated as the rule rather than as a claim about THIS
    // date. `complianceAsOfDate` returns the trading date while the premises has hours containing the
    // instant and the calendar date otherwise, and a screen that called every as-of date a trading date
    // would be wrong on exactly the days the salon does not open.
    `<p><strong>Judged against ${safeText(view.asOf)}</strong>. Overdue is decided against the ` +
      '<strong>trading</strong> date whenever the premises is open: a session that runs past midnight ' +
      'belongs to the day it opened, so in the small hours the business is still working the previous ' +
      'trading date and an obligation due that date is not yet overdue. In the daytime gap, when the ' +
      'previous session has ended, the calendar date is what it is judged against.</p>',
    // The trading hours are deliberately NOT written out here. They are a `premises_hours` row the owner
    // can change, and `nap-hours-literal-outside-the-seed` refuses the literal in any rendered surface
    // for exactly that reason: a page with the times typed in goes on showing the old ones.
    '<ul>',
    `<li><strong>Reminders:</strong> ${safeText(ladder(view.reminderOffsetsDays, 'before the deadline'))}.</li>`,
    `<li><strong>Escalation:</strong> ${safeText(
      ladder(view.escalationOffsetsDays, 'after an unacknowledged deadline', true),
    )}, to the role above the one that owes it.</li>`,
    '<li><strong>Acknowledging</strong> an occurrence stops its escalations and deliberately not its ' +
      'reminders: a reminder stays true however many people have read it.</li>',
    '</ul>',
    '<p>Whether an obligation blocks, and what it blocks, is not configuration. It follows from the ' +
      'licence and the duty, and there is no settings key that changes it.</p>',
    '</div>',
    '<h2>Obligations</h2>',
    '<table><caption>Every obligation definition, its owner, the role its escalations go to, and the ' +
      'first due date on file</caption><thead><tr>' +
      '<th scope="col">Obligation</th><th scope="col">Kind</th><th scope="col">Owner &rarr; escalates to</th>' +
      '<th scope="col">If overdue</th><th scope="col">Evidence</th><th scope="col">First due</th>' +
      '<th scope="col">Authority</th><th scope="col">Status of the duty</th>' +
      `</tr></thead><tbody>${view.obligations.map(obligationRow).join('')}</tbody></table>`,
    '<h2>Occurrences</h2>',
    occurrences,
    '</main>',
    '</body>',
    '</html>',
  ].join('')
}

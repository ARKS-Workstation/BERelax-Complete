import { safeText } from '@berelax/core'
import { tokensCss } from '@berelax/ui'
import { ADMIN_SHELL_CSS, renderAdminChromeClose, renderAdminChromeOpen } from '@berelax/ui/admin'
import {
  ADMIN_BANNER_CSS,
  renderAdminBanner,
} from '../../../src/components/admin/google-reauth-banner.ts'
import { QUICK_BOOK_CSS } from '../quick-book/render.ts'
import { RECORD_VISIT_FIELDS, RECORD_VISIT_PATH, type RecordVisitView } from './view.ts'

/**
 * The record-a-missed-visit screen, as HTML.
 *
 * Pure: a view in, a document out. No database and no clock, which is what lets
 * `apps/web/src/record-visit-render.test.ts` assert the screen without a server and what makes two renders
 * of one view byte-identical.
 *
 * ## The CSS is quick-book's, imported rather than copied
 *
 * This is the same idiom: a front-desk form, stacked fields, 2.75rem touch targets, a stated focus ring.
 * A second copy would be sixty lines that drift — the first token renamed in one and not the other is a
 * screen that looks nearly right, which is the hardest kind of difference to see. The honest home for it is
 * `packages/ui/src/admin` beside `ADMIN_SHELL_CSS`, and that is the move to make when a THIRD screen wants
 * it; moving it now would rewrite `quick-book-render.test.ts` for the sake of tidiness.
 *
 * ## No inline script, deliberately
 *
 * Quick-book has one, which narrows its start list against the chosen treatment. There is no list to narrow
 * here — the start is typed — so this screen has nothing to add and adds nothing. Every control is a native
 * `<input>`, `<select>` or `<button type="submit">` inside a `<form method="post">`, so the whole screen is
 * operable by keyboard and works with JavaScript off.
 */

const attribute = (name: string, value: string): string => `${name}="${safeText(value)}"`

/** A hidden input carrying a value across the two POSTs. The body is the only place these travel. */
const carried = (name: string, value: string): string =>
  `<input type="hidden" ${attribute('name', name)} ${attribute('value', value)}>`

/**
 * Every field of the entry, carried into the confirm POST.
 *
 * The phone number, the treatment, the client's gender, the day, the time and the outcome all travel in the
 * POST body and never in a URL, for ADR 0014's reason: a query string is in every proxy log and a mobile
 * number is the customer's identity in this system.
 */
function carriedEntry(view: RecordVisitView): string {
  const f = RECORD_VISIT_FIELDS
  return [
    carried(f.phone, view.form.phone),
    carried(f.variant, view.form.variant),
    carried(f.gender, view.form.gender),
    carried(f.date, view.form.date),
    carried(f.time, view.form.time),
    carried(f.outcome, view.form.outcome),
    carried(f.reason, view.form.reason),
    carried(f.notes, view.form.notes),
  ].join('')
}

function entryForm(view: RecordVisitView): string {
  const f = RECORD_VISIT_FIELDS
  return [
    `<form method="post" ${attribute('action', RECORD_VISIT_PATH)} data-testid="record-visit-form">`,
    carried(f.step, 'check'),
    '<label class="field">',
    '<span class="label">Mobile number</span>',
    `<input type="tel" ${attribute('name', f.phone)} ${attribute('value', view.form.phone)} ` +
      'inputmode="tel" autocomplete="off" required data-testid="record-visit-phone">',
    '</label>',
    '<label class="field">',
    '<span class="label">Treatment given</span>',
    `<select ${attribute('name', f.variant)} required data-testid="record-visit-variant">`,
    '<option value="">Choose…</option>',
    ...view.variants.map(
      (variant) =>
        `<option ${attribute('value', variant.serviceVariantId)}` +
        `${variant.serviceVariantId === view.form.variant ? ' selected' : ''}>` +
        `${safeText(variant.label)} (${variant.durationMinutes} min)</option>`,
    ),
    '</select>',
    '<span class="hint">The length decides when the treatment ended, so it has to be the one that was given.</span>',
    '</label>',
    '<fieldset>',
    '<legend>Who the treatment was for</legend>',
    ...(['female', 'male'] as const).map(
      (value) =>
        '<label class="choice">' +
        `<input type="radio" ${attribute('name', f.gender)} ${attribute('value', value)}` +
        `${view.form.gender === value ? ' checked' : ''} required ` +
        `data-testid="record-visit-gender-${value}">` +
        `<span>${value === 'female' ? 'Female' : 'Male'}</span>` +
        '</label>',
    ),
    '<span class="hint">The same-gender rule is checked on the way in, exactly as for a live booking.</span>',
    '</fieldset>',
    '<label class="field">',
    '<span class="label">Day of the visit</span>',
    `<input type="date" ${attribute('name', f.date)} ${attribute('value', view.form.date)} ` +
      'required data-testid="record-visit-date">',
    `<span class="hint">Up to ${view.horizonDays} days back. Older than that and a manager has to widen the window.</span>`,
    '</label>',
    '<label class="field">',
    '<span class="label">Time it started</span>',
    `<input type="time" ${attribute('name', f.time)} ${attribute('value', view.form.time)} ` +
      'required data-testid="record-visit-time">',
    '</label>',
    '<fieldset>',
    '<legend>What happened</legend>',
    ...(
      [
        ['completed', 'The treatment was given'],
        ['no_show', 'The client did not arrive'],
      ] as const
    ).map(
      ([value, label]) =>
        '<label class="choice">' +
        `<input type="radio" ${attribute('name', f.outcome)} ${attribute('value', value)}` +
        `${view.form.outcome === value ? ' checked' : ''} required ` +
        `data-testid="record-visit-outcome-${value}">` +
        `<span>${label}</span>` +
        '</label>',
    ),
    // Stated on the form rather than discovered afterwards: a no-show is still a visit the diary, the
    // utilisation figures and the commission run need, and a completed one is the only outcome that puts
    // money in the day's takings.
    '<span class="hint">A treatment that was given goes into the day’s takings. A no-show does not, and is ' +
      'still recorded — the diary and the commission run both need it.</span>',
    '</fieldset>',
    '<label class="field">',
    '<span class="label">Why it was not entered at the time <em>(optional)</em></span>',
    `<input type="text" ${attribute('name', f.reason)} ${attribute('value', view.form.reason)} ` +
      'maxlength="500" data-testid="record-visit-reason">',
    '<span class="hint">Stored on every step of the entry, so a reader of the history is told without asking.</span>',
    '</label>',
    '<label class="field">',
    '<span class="label">Notes <em>(optional)</em></span>',
    `<textarea ${attribute('name', f.notes)} maxlength="2000" data-testid="record-visit-notes">` +
      `${safeText(view.form.notes)}</textarea>`,
    '</label>',
    '<button type="submit" data-testid="record-visit-check">Check this entry</button>',
    '</form>',
  ].join('')
}

/**
 * What was resolved, and the two lists the desk picks from.
 *
 * The therapist list is who was ON SHIFT on that trading date, and the excluded list below it says who was
 * considered and removed. Both are option lists and neither is a permission: `createBooking` re-applies
 * B-AVAIL-04's eligibility read model inside its own transaction and refuses by name, and 0024's exclusion
 * constraint refuses an overlap whatever this list said.
 */
function checkedPanel(view: RecordVisitView): string {
  const checked = view.checked
  if (checked === null) return ''
  const f = RECORD_VISIT_FIELDS
  return [
    '<div class="assignment" data-testid="record-visit-checked" ' +
      `${attribute('data-trading-date', checked.tradingDate)}>`,
    '<h2>Check this, then record it</h2>',
    '<dl>',
    `<dt>Trading date</dt><dd data-testid="record-visit-trading-date">${safeText(checked.tradingDate)}</dd>`,
    `<dt>Treatment</dt><dd>${safeText(checked.startLabel)} — ${safeText(checked.endLabel)}</dd>`,
    `<dt>${checked.outcome === 'completed' ? 'Into the takings' : 'Not charged'}</dt>` +
      `<dd data-testid="record-visit-price">${safeText(checked.priceLabel)}</dd>`,
    '</dl>',
    `<form method="post" ${attribute('action', RECORD_VISIT_PATH)} data-testid="record-visit-confirm-form">`,
    carried(f.step, 'record'),
    carriedEntry(view),
    '<label class="field">',
    '<span class="label">Therapist who gave the treatment</span>',
    `<select ${attribute('name', f.therapist)} required data-testid="record-visit-therapist">`,
    '<option value="">Choose…</option>',
    ...checked.therapists.map(
      (therapist) =>
        `<option ${attribute('value', therapist.therapistId)}` +
        `${therapist.therapistId === view.form.therapist ? ' selected' : ''}>` +
        `${safeText(therapist.reference)}</option>`,
    ),
    '</select>',
    '<span class="hint">Everyone who was on shift that day. If the right person is not here, they were not ' +
      'rostered — the entry will be refused rather than written against somebody who was not working.</span>',
    '</label>',
    '<label class="field">',
    '<span class="label">Room</span>',
    `<select ${attribute('name', f.room)} required data-testid="record-visit-room">`,
    '<option value="">Choose…</option>',
    ...checked.rooms.map(
      (room) =>
        `<option ${attribute('value', room.roomId)}` +
        `${room.roomId === view.form.room ? ' selected' : ''}>${safeText(room.label)}</option>`,
    ),
    '</select>',
    '</label>',
    '<button type="submit" data-testid="record-visit-record">Record this visit</button>',
    '</form>',
    checked.excluded.length === 0
      ? ''
      : [
          '<h2>Not on shift that day</h2>',
          '<table data-testid="record-visit-excluded"><thead><tr><th scope="col">Therapist</th>',
          '<th scope="col">Why</th></tr></thead><tbody>',
          ...checked.excluded.map(
            (row) =>
              `<tr ${attribute('data-reason', row.reason)}><td>${safeText(row.reference)}</td>` +
              `<td>${safeText(row.reason)}</td></tr>`,
          ),
          '</tbody></table>',
        ].join(''),
    '</div>',
  ].join('')
}

/**
 * What was written, and where to find it.
 *
 * The walked steps are listed rather than summarised as "completed", because the walk is the point: the
 * entry went `confirmed → checked_in → in_progress → completed` through the same transition machine a live
 * visit uses, so it has the same history rows, the same audit rows and the same outbox events. An
 * appointment that arrived at `completed` with no history behind it would be a row no audit can account for.
 */
function recordedPanel(view: RecordVisitView): string {
  const done = view.recorded
  if (done === null) return ''
  return [
    `<div class="confirmation" data-testid="record-visit-recorded" ${attribute('data-booking', done.bookingId)}>`,
    `<h2>${done.outcome === 'completed' ? 'Visit recorded' : 'No-show recorded'}</h2>`,
    '<dl>',
    `<dt>Trading date</dt><dd>${safeText(done.tradingDate)}</dd>`,
    `<dt>Started</dt><dd>${safeText(done.startLabel)}</dd>`,
    `<dt>${done.outcome === 'completed' ? 'Into the takings' : 'Not charged'}</dt>` +
      `<dd>${safeText(done.priceLabel)}</dd>`,
    `<dt>Booking</dt><dd><code>${safeText(done.bookingId)}</code></dd>`,
    `<dt>Appointments</dt><dd>${done.appointmentIds
      .map((id) => `<code>${safeText(id)}</code>`)
      .join(' ')}</dd>`,
    `<dt>Lifecycle</dt><dd data-testid="record-visit-walked">${done.walked
      .map((step) => safeText(step))
      .join(' → ')}</dd>`,
    '</dl>',
    '<p>Every step above records that the entry was made after the fact, and when. The treatment is now in ' +
      'the diary, in the therapist’s utilisation and in the commission run' +
      (done.outcome === 'completed' ? ', and its money is in the day’s takings.' : '.') +
      '</p>',
    '</div>',
  ].join('')
}

export function renderRecordVisitHtml(view: RecordVisitView): string {
  const refused = view.refusal
  return [
    '<!doctype html>',
    `<html lang="en" dir="${view.direction}"` +
      `${refused === null ? '' : ` data-record-visit-refusal="${safeText(refused.name)}"`}>`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    // No brand in the title, for the reason quick-book's render records: the brand rule is about how the
    // full trading name is written wherever it appears, so an internal screen not writing it is compliant.
    '<title>Record a missed visit — admin</title>',
    `<style>${tokensCss()}${ADMIN_SHELL_CSS}${QUICK_BOOK_CSS}${ADMIN_BANNER_CSS}</style>`,
    '</head>',
    '<body>',
    renderAdminChromeOpen({
      title: 'Record a missed visit',
      path: RECORD_VISIT_PATH,
      role: view.chrome.role,
      staffReference: view.chrome.staffReference,
    }),
    '<main>',
    renderAdminBanner(view.chrome),
    '<h1>Record a missed visit</h1>',
    '<div class="lede">',
    '<p><strong>A treatment that happened and was never typed in.</strong></p>',
    '<p data-testid="record-visit-lede">It goes in through the same lifecycle a live visit does, so the ' +
      'diary, the therapist’s utilisation, the commission run and the books all see it. Every step says it ' +
      'was entered after the fact, and when.</p>',
    '</div>',
    // `role="status"` with `aria-live="polite"`: every outcome on this screen arrives as a new document, so
    // the live region is what a screen-reader user hears instead of being told to go and look for it.
    '<p class="live" role="status" aria-live="polite" data-testid="record-visit-live">' +
      `${safeText(view.announcement)}</p>`,
    refused === null
      ? ''
      : `<div class="notice" data-testid="record-visit-refusal" ${attribute('data-refusal', refused.name)}>` +
        `<p>${safeText(refused.sentence)}</p>` +
        (refused.detail === null
          ? ''
          : `<p data-testid="record-visit-refusal-detail"><code>${safeText(refused.detail)}</code></p>`) +
        '</div>',
    recordedPanel(view),
    checkedPanel(view),
    view.recorded === null ? entryForm(view) : '',
    '</main>',
    renderAdminChromeClose(),
    '</body>',
    '</html>',
  ].join('')
}

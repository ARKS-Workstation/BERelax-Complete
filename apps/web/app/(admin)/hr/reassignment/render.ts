import { safeText } from '@berelax/core'
import { tokensCss } from '@berelax/ui'

/**
 * The reassignment queue, as HTML.
 *
 * Pure: rows in, a document out, no database and no clock. The instant the page was read at arrives in
 * the view and is printed on it, which is the same rule the credentials screen next door follows — a
 * screen that said "as of now" could not produce two identical screenshots on a repeat run.
 *
 * ## Why this is a document served by a route handler and not a `page.tsx`
 *
 * `apps/web/src/routes/registry.ts` is in exact bijection with the filesystem and requires every
 * **document** to be served in both locales (`registry.test.ts`: "gives every document a locale"), so a
 * `page.tsx` here would need an Arabic admin document and the admin shell W-SYS-01 has not built one —
 * and it would join a screenshot matrix whose RTL half must be a real Arabic route. The credentials
 * screen one directory along gives the same reason, and P-HR-02's NOTE records it as the arrangement
 * every HR surface takes until W-SYS-01 lands.
 *
 * ## What it shows, and what it must not
 *
 * The appointment, when it starts, which credential took its therapist off it, and the therapist's
 * internal handle — `staff_reference`, "Therapist 07". Never a name: nineteen employees have none
 * recorded and the ones that do have it under a publication guard (ADR 0020, brief rule 10). The
 * customer is not named or identified at all; nothing on a work queue needs them, and this page is not
 * authenticated until W-SYS-01.
 *
 * It shows no CANDIDATES either, and that is a scoping decision rather than an omission. The candidate
 * finder needs the client's gender under strict same-gender matching, no table holds it (B-AVAIL-05:
 * `customer` has no gender column), and a page that listed candidates without it would be listing
 * therapists the reassign transaction then refuses — the exact failure this unit exists to prevent.
 * Acting on the queue from a browser is therefore W-SYS-01's, and the manifest NOTE says so.
 */

/** One queue entry, as the route reads it. Ids and dates; no customer, no names. */
export interface ReassignmentQueueEntryView {
  readonly appointmentId: string
  readonly therapistReference: string | null
  /** ISO 8601, so the page prints one zone and a screenshot is reproducible. */
  readonly startsAtIso: string
  readonly tradingDate: string
  readonly reason: string
  readonly documentType: string
  readonly documentExpiresOn: string | null
  readonly detectedOn: string
  readonly roomCode: string
  readonly shape: string
  readonly appointmentStatus: string
}

export interface ReassignmentQueueView {
  /** In working order: soonest appointment first. Ordered by the reader, printed as given. */
  readonly entries: readonly ReassignmentQueueEntryView[]
  /** The instant the page was read at, as ISO 8601. */
  readonly readAtIso: string
}

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
  ol.queue { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-5); }
  article {
    background: var(--color-surface);
    border: 1px solid var(--color-hairline);
    border-radius: var(--radius-2);
    padding: var(--space-5);
  }
  .head { display: flex; flex-wrap: wrap; gap: var(--space-3) var(--space-5); align-items: baseline; }
  .reason { display: inline-flex; align-items: center; gap: var(--space-3); font-weight: 600; }
  .dot { width: var(--space-4); height: var(--space-4); border-radius: var(--radius-handle); }
  .dot-credential_expired { background: var(--color-danger); }
  .dot-credential_missing { background: var(--color-ink-3); }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: var(--space-3) var(--space-5); margin: var(--space-5) 0 0; }
  dt { color: var(--color-ink-2); font-size: 0.875rem; }
  dd { margin: 0; font-variant-numeric: tabular-nums; }
  .empty {
    border: 1px dashed var(--color-border);
    border-radius: var(--radius-2);
    padding: var(--space-9) var(--space-5);
    text-align: center;
    color: var(--color-ink-2);
  }
`

/**
 * The instant, in the timezone the business trades in.
 *
 * `Asia/Dubai` and `en-GB`, for the reason the credentials screen gives: the reader is in Abu Dhabi, an
 * implicit locale would make the rendering depend on a request header, and a UTC timestamp printed
 * beside a trading date is how somebody concludes the page is wrong. It matters here because the queue
 * is ordered by when the appointment starts, and that is a wall-clock fact.
 */
const DUBAI = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Dubai',
  weekday: 'short',
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

/** The document type, as a person reads it. `labour_card` is not a word anybody says out loud. */
const typeLabel = (documentType: string): string =>
  documentType.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase())

function entryArticle(entry: ReassignmentQueueEntryView): string {
  // The word, always, with the colour as a second signal and never the only one: a status told by colour
  // alone cannot be read by a colour-blind operator, which docs/08 treats as a defect.
  const reason =
    `<span class="reason"><span class="dot dot-${safeText(entry.reason)}" aria-hidden="true"></span>` +
    `${safeText(entry.reason.replaceAll('_', ' '))}</span>`
  return (
    '<li><article>' +
    '<div class="head">' +
    `<h2>${safeText(DUBAI.format(new Date(entry.startsAtIso)))}</h2>${reason}` +
    '</div>' +
    '<dl>' +
    // The handle, never a name. NULL means the employee row has gone, which is possible because
    // `appointment.therapist_id` is deliberately not a foreign key (0024).
    `<dt>Therapist</dt><dd>${safeText(entry.therapistReference ?? 'not on file')}</dd>` +
    `<dt>Credential</dt><dd>${safeText(typeLabel(entry.documentType))}${
      entry.documentExpiresOn === null
        ? ' (no document on file)'
        : `, expired ${safeText(entry.documentExpiresOn)}`
    }</dd>` +
    `<dt>Trading date</dt><dd>${safeText(entry.tradingDate)}</dd>` +
    `<dt>Room</dt><dd>${safeText(entry.roomCode)} (${safeText(entry.shape.replaceAll('_', ' '))})</dd>` +
    `<dt>Booking status</dt><dd>${safeText(entry.appointmentStatus)}</dd>` +
    `<dt>Flagged on</dt><dd>${safeText(entry.detectedOn)}</dd>` +
    `<dt>Appointment</dt><dd>${safeText(entry.appointmentId)}</dd>` +
    '</dl>' +
    '</article></li>'
  )
}

export function renderReassignmentQueueHtml(view: ReassignmentQueueView): string {
  const body =
    view.entries.length === 0
      ? '<p class="empty">Nothing is waiting for a different therapist. An empty queue is the ordinary ' +
        'state: the nightly credential sweep raises a flag only when a mandatory document has lapsed ' +
        'over an appointment already in the diary.</p>'
      : `<ol class="queue">${view.entries.map((entry) => entryArticle(entry)).join('')}</ol>`

  return [
    '<!doctype html>',
    '<html lang="en" dir="ltr">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    // No brand in the title: docs/09's "brand collision" forbids the bare brand in any title and
    // `apps/web/src/seo/brand.test.ts` scans every title-bearing line in `apps/web` for it. An internal
    // back-office screen has no reason to name the business at all.
    '<title>Reassignment queue — HR admin</title>',
    `<style>${tokensCss()}${QUEUE_CSS}</style>`,
    '</head>',
    '<body>',
    '<main>',
    '<h1>Reassignment queue</h1>',
    '<div class="policy">',
    `<p><strong>Read at ${safeText(DUBAI.format(new Date(view.readAtIso)))} Dubai.</strong> ` +
      'Soonest appointment first, which is the order the work has to be done in — not the order the ' +
      'flags were raised in. Every booking below is intact: the customer has not been told anything, ' +
      'the room and the hour are unchanged, and the therapist still holds it until somebody decides ' +
      'otherwise.</p>',
    '<p>A queue entry leaves only three ways, and each one is recorded on the flag: the therapist is ' +
      'reassigned, the credential position is restored and the nightly sweep withdraws it, or somebody ' +
      'closes it by hand with a written reason. There is no fourth way — nothing deletes a flag.</p>',
    '<p>Reassigning from a browser needs the client’s gender, which no table holds under strict ' +
      'same-gender matching (ADR 0020), so this page reports the queue and does not act on it. The ' +
      'transaction is <code>reassignAppointment</code>.</p>',
    '</div>',
    body,
    '</main>',
    '</body>',
    '</html>',
  ].join('')
}

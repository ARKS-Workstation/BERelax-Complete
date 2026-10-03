import { PAPER_FALLBACK_STEPS, safeText } from '@berelax/core'
import { tokensCss } from '@berelax/ui'
import {
  ADMIN_BANNER_CSS,
  type AdminChrome,
  renderAdminBanner,
} from '../../../../src/components/admin/google-reauth-banner.ts'

/**
 * `/day-sheet/print` — the paper the floor works from when the network is gone (H-HARD-08).
 *
 * Pure: a view in, a document out, no database and no clock.
 *
 * ## Why it holds NO instant of its own
 *
 * The acceptance line is *"byte-identical across two runs on the frozen seed"*, and the thing that makes
 * that impossible is a "printed at" line. Every other admin screen in this build prints the instant it was
 * read at, deliberately, because a figure without a reading time is a figure somebody quotes next week.
 * This document is the exception and the exception is the point: it is an artefact somebody carries, two
 * copies of it must be the same bytes, and ADR 0105 took the same decision for the reconciliation report —
 * *the run instant lives OUTSIDE the compared content*.
 *
 * So the only dates on it are the TRADING DATE and the session's own opening and closing times, which are
 * `business_day`'s columns and not a clock reading. If somebody needs to know when a sheet was printed they
 * write it on, which is what a person does with paper.
 *
 * ## Why it names no customer
 *
 * The sheet sits on a desk in a room customers walk through, and it is printed in advance precisely so it
 * is lying around when the network is down. A list of who is coming, at what time, for what treatment is
 * the single most sensitive artefact this business could leave face-up — docs/06 D2's discretion rule is
 * about a lock screen, and this is worse than a lock screen.
 *
 * What the floor actually needs is what it is DELIVERING: the time, the room, the therapist's handle, the
 * treatment and the appointment's own short reference, which is what a till entry is reconciled against
 * afterwards. The customer is behind that reference. Nineteen employees have no name recorded either, so
 * the therapist column is `staff_reference` (ADR 0020, brief rule 10).
 *
 * ## Why the times are pre-formatted in the view
 *
 * A renderer that formatted an instant would need `Intl` and a zone, and a zone argument is the thing that
 * is wrong once. The route formats in Asia/Dubai — the business zone — and this file prints strings.
 */

export interface DaySheetAppointmentView {
  /** The first eight characters of the appointment id: what a till entry is reconciled against. */
  readonly reference: string
  readonly startsAtLabel: string
  readonly endsAtLabel: string
  readonly roomCode: string
  /** Handles, never names. A delivery with two therapists lists both. */
  readonly therapistReferences: readonly string[]
  readonly serviceLabel: string
  readonly status: string
  /** True when the treatment starts after midnight, so the sheet marks the session's tail. */
  readonly afterMidnight: boolean
}

export interface DaySheetPageView {
  readonly chrome: AdminChrome
  readonly tradingDate: string
  /** Null when `business_day` holds no session for the date, which is a closure and not an error. */
  readonly session: { readonly opensAtLabel: string; readonly closesAtLabel: string } | null
  readonly appointments: readonly DaySheetAppointmentView[]
  /** Rooms that are bookable, so an empty column is visibly empty rather than absent. */
  readonly roomCodes: readonly string[]
}

const DAY_SHEET_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    padding: var(--space-5) var(--gutter);
    background: var(--color-ground);
    color: var(--color-ink);
    font: 1rem/1.4 system-ui, sans-serif;
  }
  main { max-width: 60rem; margin: 0 auto; }
  h1 { font-size: 1.375rem; margin: 0 0 var(--space-2); }
  h2 { font-size: 1rem; margin: var(--space-5) 0 var(--space-2); }
  p { margin: 0 0 var(--space-3); }
  table { border-collapse: collapse; width: 100%; }
  caption { text-align: start; font-weight: 600; padding: 0 0 var(--space-2); }
  th, td {
    text-align: start;
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--color-hairline);
    vertical-align: top;
  }
  th { border-bottom: 2px solid var(--color-border); }
  td.ref { font-variant-numeric: tabular-nums; }
  tr[data-after-midnight="true"] td { background: var(--color-surface-sand); }
  .tender { width: 8rem; }
  .policy {
    border: 1px solid var(--color-border);
    border-inline-start: var(--space-2) solid var(--color-border);
    border-radius: var(--radius-2);
    background: var(--color-surface-sand);
    padding: var(--space-5);
    margin: 0 0 var(--space-5);
  }
  ol { margin: 0; padding-inline-start: var(--space-7); }
  /*
    Print, and the two rules that are not decoration: the banners and the instructions do not belong on a
    sheet somebody is reading at a desk under pressure, and a page break through a row loses a treatment.
  */
  @media print {
    /*
      No background or colour literal here. A print stylesheet does not need them: a printing
      browser drops backgrounds by default and prints text as ink, so the white-on-black pair only
      restated that - and the colour gate is right to refuse two colours that are in no palette (it
      reads comments too, which is why the pair is described here rather than quoted).
      Removed at the H-HARD-08 merge; the padding reset is the part that was doing work.
    */
    body { padding: 0; }
    [data-google-reauth], [data-messages-delayed], .screen-only { display: none; }
    tr { break-inside: avoid; }
    table { font-size: 0.9375rem; }
  }
`

export function renderDaySheetHtml(view: DaySheetPageView): string {
  return [
    '<!doctype html>',
    '<html lang="en" dir="ltr">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    // No brand in the title: docs/09's brand-collision rule forbids the bare brand in any title.
    `<title>Day sheet ${safeText(view.tradingDate)} — front desk</title>`,
    `<style>${tokensCss()}${DAY_SHEET_CSS}${ADMIN_BANNER_CSS}</style>`,
    '</head>',
    '<body>',
    '<main>',
    renderAdminBanner(view.chrome),
    `<h1>Day sheet — trading day ${safeText(view.tradingDate)}</h1>`,
    view.session === null
      ? '<p data-day-sheet-session="closed"><strong>The premises has no trading session on this date.</strong> ' +
        'That is a closure rather than an error: `business_day` holds no row, so nothing can be rostered ' +
        'or booked, and anything below would be a treatment the calendar cannot offer.</p>'
      : `<p data-day-sheet-session="open"><strong>Open ${safeText(view.session.opensAtLabel)} to ` +
        `${safeText(view.session.closesAtLabel)} Dubai.</strong> The session runs past midnight, so a ` +
        'treatment at 01:30 belongs to THIS trading day and is on this sheet — the shaded rows below.</p>',
    '<div class="policy screen-only">',
    '<p><strong>Print this at the start of every shift.</strong> It is the fallback when the network is ' +
      'gone, and it is useless printed afterwards. It carries no "printed at" line on purpose: two prints ' +
      'of an unchanged day are the same bytes, so a sheet can be compared with another sheet. Write the ' +
      'time on it yourself.</p>',
    '<p>It names no customer. A list of who is coming, when, for what treatment is the most sensitive ' +
      'thing this business could leave face-up on a desk, and this sheet is printed precisely so it is ' +
      'lying around. The reference column is what a till entry is reconciled against afterwards.</p>',
    '<h2>If the connection goes</h2>',
    '<ol>',
    ...PAPER_FALLBACK_STEPS.map((step) => `<li>${safeText(step)}</li>`),
    '</ol>',
    '</div>',
    view.appointments.length === 0
      ? '<p data-day-sheet-appointments="none"><strong>No treatment is booked for this trading day.</strong> ' +
        'That is not "the sheet could not be read": the day exists and holds nothing.</p>'
      : [
          '<table>',
          `<caption>${view.appointments.length} treatment(s), earliest first</caption>`,
          '<thead><tr>',
          '<th scope="col">From</th><th scope="col">To</th><th scope="col">Room</th>',
          '<th scope="col">Therapist</th><th scope="col">Treatment</th><th scope="col">Ref</th>',
          '<th scope="col">Status</th><th scope="col" class="tender">Paid (write in)</th>',
          '</tr></thead><tbody>',
          ...view.appointments.map((appointment) =>
            [
              `<tr data-after-midnight="${appointment.afterMidnight ? 'true' : 'false'}">`,
              `<td>${safeText(appointment.startsAtLabel)}</td>`,
              `<td>${safeText(appointment.endsAtLabel)}</td>`,
              `<td>${safeText(appointment.roomCode)}</td>`,
              // Joined with a comma rather than one row per therapist: a two-therapist delivery is ONE
              // treatment in one room, and two rows would be read as two bookings.
              `<td>${safeText(appointment.therapistReferences.join(', '))}</td>`,
              `<td>${safeText(appointment.serviceLabel)}</td>`,
              `<td class="ref">${safeText(appointment.reference)}</td>`,
              `<td>${safeText(appointment.status)}</td>`,
              // Deliberately blank. The sheet does not record a payment — a column this system filled in
              // would be a claim it cannot make while the network is down, and this one is a human's.
              '<td class="tender"></td>',
              '</tr>',
            ].join(''),
          ),
          '</tbody></table>',
        ].join(''),
    view.roomCodes.length === 0
      ? ''
      : `<p class="screen-only">Bookable rooms today: ${safeText(view.roomCodes.join(', '))}. A room with ` +
        'no treatment on the sheet is free, not missing.</p>',
    '</main>',
    '</body>',
    '</html>',
  ].join('')
}

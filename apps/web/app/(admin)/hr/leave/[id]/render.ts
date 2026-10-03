import { safeText } from '@berelax/core'
import { tokensCss } from '@berelax/ui'
import {
  ADMIN_BANNER_CSS,
  type AdminChrome,
  renderAdminBanner,
} from '../../../../../src/components/admin/google-reauth-banner.ts'

/**
 * One leave request, and everything an approval of it would have to step over.
 *
 * Pure: rows in, a document out, no database and no clock. The instant the page was read at arrives in the
 * view and is printed on it, which is the rule the four HR screens next door follow — a screen that said "as
 * of now" could not produce two identical screenshots on a repeat run.
 *
 * ## Why this is a document served by a route handler and not a `page.tsx`
 *
 * The manifest's `files` list says `page.tsx`, and it is corrected in a NOTE.
 * `apps/web/src/routes/registry.ts` is in exact bijection with the filesystem and requires every **document**
 * to be served in both locales (`registry.test.ts`: "gives every document a locale"), so a `page.tsx` here
 * would need an Arabic admin document nobody has built, and it would join a screenshot matrix whose RTL half
 * must be a real Arabic route. P-HR-02's NOTE records that as the arrangement every HR surface takes, and the
 * rota, timesheets, credentials and reassignment screens are all route handlers for it.
 *
 * ## The five things this screen must say
 *
 *   1. **The period, as instants in the business zone.** A leave day covers its TRADING session, so a day of
 *      leave on the 17th runs to the small hours of the 18th — and the screen prints both ends, because the
 *      whole point of the alignment is invisible if the page says "17 March" and the conflict below is at
 *      01:30 on the 18th. No opening or closing TIME is written in this file: they live in `premises_hours`
 *      and every consumer formats them, so a literal here would be a second source of truth that went on
 *      showing the old time after an owner changed it (`packages/db/src/seed/premises.test.ts` refuses one).
 *   2. **Every conflicting appointment, with the five facts the report carries**: the customer, the service,
 *      the room, the therapist and the start instant. All of them, never a count: a count cannot be acted on,
 *      and the acceptance line is that N overlapping appointments produce N rows.
 *   3. **What has been decided about each one** — reassigned, overridden, or nothing yet — and that an
 *      approval will not commit while any is unresolved.
 *   4. **Which segments the approval would break**, by their labels, and that the figures are a provisional
 *      answer to Y9-coverage held as versioned rows.
 *   5. **That approval never cancels a booking.** Stated on the face of the screen and not only in an ADR,
 *      because the operator reading it is the person who would otherwise ask for the button that does.
 *
 * It names no therapist and no customer. `staff_reference` is the handle — "Therapist 07" — and a customer is
 * `Customer 0042`: nineteen employees have no name recorded (ADR 0020, brief rule 10) and the report needs no
 * name to be acted on.
 *
 * It is READ-ONLY, and that is not a gap left for later. An approval is a write with an actor, and
 * `leave_approval.approver_role` plus `leave_approval_cancellation.cancelled_by` are both refused a
 * placeholder by 0092 — so a button here would either invent a staff member or write a marker the database
 * refuses. `route.ts` records what is actually missing and which unit owns it.
 */

/** One appointment the leave overlaps, reduced to what an operator can act on. */
export interface LeaveConflictView {
  readonly appointmentId: string
  readonly customerId: string
  /**
   * `customer.display_name`, or null when nobody has recorded one.
   *
   * Null and not a manufactured label: `Customer 0042` is what the fixtures package mints for a synthetic
   * record, and generating the same shape here would make an invented label indistinguishable from a
   * recorded one (brief rule 15, ADR 0020). The row then names the id, which is the handle the database has.
   */
  readonly customerDisplayName: string | null
  readonly serviceLabel: string
  readonly roomCode: string
  /** `employee.staff_reference`, never a name. */
  readonly therapistReference: string
  /** The start instant as a Dubai wall clock with its date, so a 01:30 in the tail reads as 01:30. */
  readonly startsAt: string
  readonly resolution: 'unresolved' | 'reassigned' | 'overridden'
}

/** One segment an approval would break, by the label the validator produced. */
export interface LeaveCoverageBreachView {
  readonly rule: string
  readonly segmentLabel: string
}

export interface LeaveApprovalPageView {
  readonly chrome: AdminChrome
  readonly leaveRequestId: string
  readonly therapistReference: string
  readonly kind: string
  readonly status: string
  /** Both ends of the stored period, as Dubai wall clocks. */
  readonly startsAt: string
  readonly endsAt: string
  readonly fromTradingDate: string
  readonly toTradingDate: string
  readonly readAtIso: string
  readonly conflicts: readonly LeaveConflictView[]
  readonly breaches: readonly LeaveCoverageBreachView[]
  /** Segments already short without this leave. Reported, never refused on. */
  readonly preexistingBreachCount: number
  readonly minimumTherapistsOnFloor: number
  readonly coverageRuleEffectiveFrom: string
  readonly coverageOpenQuestionId: string
  /** The live approval, when there is one. Read through `leave_approval_live`. */
  readonly approval: {
    readonly approverRole: string
    readonly approvedVia: string
    readonly coverageRuleEffectiveFrom: string
    readonly conflictsOverridden: number
    readonly conflictsReassigned: number
  } | null
  /** What the viewer's role may see and do here, decided server-side. */
  readonly access: {
    readonly role: string
    readonly mayApprove: boolean
    readonly mayOverride: boolean
    readonly maySeeConflicts: boolean
  }
  readonly direction: 'ltr' | 'rtl'
}

const DUBAI = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Dubai',
  dateStyle: 'medium',
  timeStyle: 'short',
})

const LEAVE_CSS = `
main { max-width: 68ch; margin: 0 auto; padding: 1.5rem 1rem; }
h1, h2 { line-height: 1.2; }
.card { border: 1px solid var(--colour-border); border-radius: var(--radius-md);
        padding: 1rem; margin: 1rem 0; background: var(--colour-surface); }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; margin: 0; }
dt { font-weight: 600; }
dd { margin: 0; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: start; padding: 0.5rem 0.25rem; border-bottom: 1px solid var(--colour-border); }
.empty { color: var(--colour-text-muted); }
.unresolved { font-weight: 600; }
`

/** One conflict row. Every column is present for every row, so a missing fact reads as missing. */
function conflictRow(conflict: LeaveConflictView): string {
  return [
    '<tr data-conflict>',
    `<td data-field="customer">${
      conflict.customerDisplayName === null
        ? `no name recorded · ${safeText(conflict.customerId)}`
        : safeText(conflict.customerDisplayName)
    }</td>`,
    `<td data-field="service">${safeText(conflict.serviceLabel)}</td>`,
    `<td data-field="room">${safeText(conflict.roomCode)}</td>`,
    `<td data-field="therapist">${safeText(conflict.therapistReference)}</td>`,
    `<td data-field="startsAt">${safeText(conflict.startsAt)}</td>`,
    `<td data-field="resolution"${conflict.resolution === 'unresolved' ? ' class="unresolved"' : ''}>` +
      `${safeText(conflict.resolution)}</td>`,
    '</tr>',
  ].join('')
}

export function renderLeaveApprovalHtml(view: LeaveApprovalPageView): string {
  const unresolved = view.conflicts.filter(
    (conflict) => conflict.resolution === 'unresolved',
  ).length
  return [
    '<!doctype html>',
    `<html lang="en" dir="${view.direction}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    // No brand in the title: docs/09's "brand collision" forbids the bare brand in any title, and
    // `apps/web/src/seo/brand.test.ts` scans every title-bearing line in `apps/web` for it.
    '<title>Leave request — HR admin</title>',
    `<style>${tokensCss()}${LEAVE_CSS}${ADMIN_BANNER_CSS}</style>`,
    '</head>',
    '<body>',
    '<main>',
    renderAdminBanner(view.chrome),
    '<h1>Leave request</h1>',
    '<div class="card"><dl>',
    `<dt>Therapist</dt><dd data-field="therapist">${safeText(view.therapistReference)}</dd>`,
    `<dt>Kind</dt><dd data-field="kind">${safeText(view.kind)}</dd>`,
    `<dt>Status</dt><dd data-field="status">${safeText(view.status)}</dd>`,
    // Both ends, as instants. The alignment is the whole subject of this unit and it is invisible if the
    // screen prints a date: a leave day on the 17th ENDS in the small hours of the 18th, which is what
    // makes the 01:30 conflict below belong to it. The instants come from the view; no time is written here.
    `<dt>Covers</dt><dd data-field="period">${safeText(view.startsAt)} to ${safeText(view.endsAt)}</dd>`,
    `<dt>Trading dates</dt><dd data-field="tradingDates">${safeText(view.fromTradingDate)} to ` +
      `${safeText(view.toTradingDate)}</dd>`,
    `<dt>Read at</dt><dd>${safeText(DUBAI.format(new Date(view.readAtIso)))} Dubai</dd>`,
    `<dt>Viewer role</dt><dd data-field="role">${safeText(view.access.role)}</dd>`,
    '</dl></div>',
    '<p>A leave day covers its <strong>trading session</strong>, not its calendar day: trading crosses ' +
      'midnight, so the last hours of a leave day fall on the following date. An appointment in that tail ' +
      'is inside the leave and is listed below.</p>',
    view.approval === null
      ? ''
      : `<div class="card" data-approval><p><strong>Approved</strong> by a ` +
        `${safeText(view.approval.approverRole)} on their ` +
        `${safeText(view.approval.approvedVia === 'delegation' ? 'delegated authority' : 'own authority')}` +
        `, judged against coverage rule version ${safeText(view.approval.coverageRuleEffectiveFrom)}. ` +
        `${view.approval.conflictsReassigned} appointment(s) were reassigned and ` +
        `${view.approval.conflictsOverridden} overridden.</p></div>`,
    '<h2>Conflicting appointments</h2>',
    view.access.maySeeConflicts
      ? [
          view.conflicts.length === 0
            ? '<p class="empty" data-conflicts="0">No appointment overlaps this leave.</p>'
            : [
                `<p data-conflicts="${view.conflicts.length}">${view.conflicts.length} appointment(s) ` +
                  `overlap this leave, ${unresolved} of them unresolved. An approval does not commit ` +
                  'while any is unresolved.</p>',
                '<table><thead><tr><th>Customer</th><th>Service</th><th>Room</th><th>Therapist</th>',
                '<th>Starts</th><th>Decided</th></tr></thead><tbody>',
                view.conflicts.map(conflictRow).join(''),
                '</tbody></table>',
              ].join(''),
          // The boundary, on the face of the screen. An operator who cannot find the cancel button is the
          // person who asks for it, and this is the answer to that question rather than a silence.
          '<p>Each conflict is resolved by <strong>reassigning the appointment to another therapist</strong> ' +
            'or by an <strong>audited override</strong> that leaves it standing with a written reason. ' +
            'Approving leave never cancels a booking and never marks one a no-show: a customer learning ' +
            'their appointment is gone because somebody was granted a holiday is not a resolution.</p>',
        ].join('')
      : // A refused reader is rendered as a page rather than a 403, because "you may not see this" is
        // information the operator needs on the screen they are on. It names no customer.
        `<p class="empty" data-conflicts="withheld">A ${safeText(view.access.role)} may not see which ` +
        'clients have appointments with this therapist, so the report is withheld. The count is withheld ' +
        'too: a number is enough to tell somebody whether a named colleague has bookings.</p>',
    '<h2>Floor coverage</h2>',
    '<div class="card"><dl>',
    `<dt>Minimum on the floor</dt><dd data-field="minimumOnFloor">` +
      `${view.minimumTherapistsOnFloor} therapist(s) in every 30-minute segment</dd>`,
    `<dt>Rule version</dt><dd data-field="coverageVersion">` +
      `${safeText(view.coverageRuleEffectiveFrom)}</dd>`,
    '</dl></div>',
    view.breaches.length === 0
      ? '<p class="empty" data-breaches="0">Approving this leave breaks no segment that is covered ' +
        'without it.</p>'
      : [
          `<p data-breaches="${view.breaches.length}">Approving this leave would leave ` +
            `${view.breaches.length} segment(s) short that are covered without it, so it is refused:</p>`,
          '<ul>',
          view.breaches
            .map(
              (breach) =>
                `<li data-breach>${safeText(breach.segmentLabel)} — ${safeText(breach.rule)}</li>`,
            )
            .join(''),
          '</ul>',
        ].join(''),
    view.preexistingBreachCount === 0
      ? ''
      : `<p class="empty" data-preexisting="${view.preexistingBreachCount}">` +
        `${view.preexistingBreachCount} segment(s) are already short without this leave. They are ` +
        'reported and not refused on: refusing here would make leave unapprovable for a shortfall the ' +
        'requester cannot do anything about.</p>',
    // The provisional banner. docs/12 §2 requires a provisional figure to be visible where it is USED and
    // not only on the Unconfirmed Assumptions panel.
    `<p><strong>The floor minimum is provisional</strong> (${safeText(view.coverageOpenQuestionId)}). ` +
      'It is a versioned row rather than a setting, so confirming it publishes a new version and leaves ' +
      'what an earlier approval was judged against unchanged.</p>',
    '<h2>What this screen cannot do</h2>',
    `<p data-field="writes">Read-only. Approving, overriding and withdrawing are writes with an actor, and ` +
      'this application has no staff session to attribute one to — the database refuses a placeholder ' +
      `approver outright. The viewer role above ${view.access.mayApprove ? 'would hold' : 'does not hold'} ` +
      `the approval permission and ${view.access.mayOverride ? 'would hold' : 'does not hold'} the ` +
      'override authority; both are decided on the server and neither is taken from the query string.</p>',
    '</main>',
    '</body>',
    '</html>',
  ].join('')
}

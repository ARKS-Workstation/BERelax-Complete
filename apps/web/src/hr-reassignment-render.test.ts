import { describe, expect, it } from 'vitest'
import {
  type ReassignmentQueueEntryView,
  type ReassignmentQueueView,
  renderReassignmentQueueHtml,
} from '../app/(admin)/hr/reassignment/render.ts'

/**
 * The reassignment queue document, without a server (P-HR-04).
 *
 * Everything the acceptance criterion asks to be *visible* is decidable from the markup: the order, the
 * flag's reason, the credential that caused it, and the three things it must not print — a customer, a
 * therapist's name, or a way to act on the queue.
 *
 * Every assertion has its control. "The reason is shown" is satisfied by a renderer that prints a
 * coloured dot and no word, so the WORD is asserted (a status told by colour alone is a defect docs/08
 * names); "the customer is not named" is satisfied by a renderer that prints nothing at all, so the
 * therapist's handle and the appointment id are asserted present in the same document.
 */
const ENTRY: ReassignmentQueueEntryView = {
  appointmentId: '00000000-0000-7000-8000-000000000001',
  therapistReference: 'Therapist 07',
  startsAtIso: '2026-10-01T16:00:00.000Z',
  tradingDate: '2026-10-01',
  reason: 'credential_expired',
  documentType: 'labour_card',
  documentExpiresOn: '2026-09-30',
  detectedOn: '2026-09-30',
  roomCode: 'room-1',
  shape: 'solo',
  appointmentStatus: 'confirmed',
}

const view = (entries: readonly ReassignmentQueueEntryView[]): ReassignmentQueueView => ({
  entries,
  readAtIso: '2026-09-30T20:00:00.000Z',
})

describe('the reassignment queue document', () => {
  it('prints the reason as a WORD, not only as a colour', () => {
    const html = renderReassignmentQueueHtml(view([ENTRY]))
    expect(html).toContain('credential expired')
    // The control: the colour is there too, as the second signal rather than the only one.
    expect(html).toContain('dot-credential_expired')
  })

  it('names the credential and the date it expired, which is what makes it actionable', () => {
    const html = renderReassignmentQueueHtml(view([ENTRY]))
    expect(html).toContain('Labour card')
    expect(html).toContain('expired 2026-09-30')
    // And a MISSING document has no date to print, so it says so rather than printing an empty cell.
    const missing = renderReassignmentQueueHtml(
      view([{ ...ENTRY, reason: 'credential_missing', documentExpiresOn: null }]),
    )
    expect(missing).toContain('no document on file')
  })

  it('prints the appointment in the order it was given, soonest first', () => {
    const later: ReassignmentQueueEntryView = {
      ...ENTRY,
      appointmentId: '00000000-0000-7000-8000-000000000002',
      startsAtIso: '2026-10-02T16:00:00.000Z',
    }
    const html = renderReassignmentQueueHtml(view([ENTRY, later]))
    expect(html.indexOf(ENTRY.appointmentId)).toBeLessThan(html.indexOf(later.appointmentId))
    // The control: the renderer does not sort, so the reversed input renders reversed. Ordering is the
    // reader's and the pure comparator's (`orderReassignmentQueue`), and a second sort here would be a
    // second answer to "what is urgent".
    const reversed = renderReassignmentQueueHtml(view([later, ENTRY]))
    expect(reversed.indexOf(later.appointmentId)).toBeLessThan(
      reversed.indexOf(ENTRY.appointmentId),
    )
  })

  it('shows the wall-clock start in Dubai, never the UTC instant', () => {
    // 16:00Z is 20:00 in Asia/Dubai, and the queue is worked by somebody standing in Abu Dhabi. A UTC
    // timestamp beside a trading date is how somebody concludes the page is four hours wrong.
    const html = renderReassignmentQueueHtml(view([ENTRY]))
    expect(html).toContain('20:00')
    expect(html).not.toContain('16:00')
  })

  it('identifies the therapist by handle and nobody else at all', () => {
    const html = renderReassignmentQueueHtml(view([ENTRY]))
    expect(html).toContain('Therapist 07')
    // No customer field, no phone, no booking id: nothing on a work queue needs them, and this surface
    // is not authenticated until W-SYS-01. Asserted on the field LIST rather than on the word, because
    // the page's own prose explains that the customer has been told nothing — which is the point of it.
    expect(html).not.toContain('<dt>Customer')
    expect(html).not.toContain('<dt>Booking</dt>')
    expect(html).not.toContain('+971')
    // An employee row that has gone says so rather than printing an empty field — `therapist_id` is
    // deliberately not a foreign key (0024), so the absence is reachable.
    expect(renderReassignmentQueueHtml(view([{ ...ENTRY, therapistReference: null }]))).toContain(
      'not on file',
    )
  })

  it('escapes what it prints', () => {
    const html = renderReassignmentQueueHtml(
      view([{ ...ENTRY, therapistReference: '<script>alert(1)</script>' }]),
    )
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('says an empty queue is the ordinary state rather than showing a blank page', () => {
    const html = renderReassignmentQueueHtml(view([]))
    expect(html).toContain('Nothing is waiting for a different therapist')
    // A blank page that looked like an empty queue is the one failure a work queue must not have, so the
    // empty state is a sentence and not an absence.
    expect(html).toContain('class="empty"')
  })

  it('offers no way to act on the queue from the page', () => {
    const html = renderReassignmentQueueHtml(view([ENTRY]))
    // Read-only, and asserted as markup rather than promised in a comment: reassigning needs an actor, a
    // reason and a client gender no table holds, so a form here would offer a therapist the transaction
    // then refuses.
    expect(html).not.toContain('<form')
    expect(html).not.toContain('<button')
    expect(html).toContain('noindex, nofollow, noarchive')
  })
})

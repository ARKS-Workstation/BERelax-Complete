import { describe, expect, it } from 'vitest'
import {
  type LeaveApprovalPageView,
  type LeaveConflictView,
  renderLeaveApprovalHtml,
} from '../app/(admin)/hr/leave/[id]/render.ts'

/**
 * P-HR-09's screen, rendered. Pure: a view in, a document out, no database and no clock.
 *
 * Everything asserted here is a claim about the DOCUMENT, and the four that matter are the four an operator
 * would act on wrongly if they were missing:
 *
 *   1. **Both ends of the period**, so the trading-session alignment is visible. A screen printing "17 March"
 *      beside a conflict at 01:30 on the 18th reads as a bug in the report.
 *   2. **Every conflict, with all five facts, on every row.** Not a count: a count cannot be acted on.
 *   3. **The unresolved ones marked**, and the sentence that an approval does not commit while any is.
 *   4. **That approving never cancels a booking**, on the face of the screen. The operator who cannot find
 *      the cancel button is the person who asks for it, and this is the answer to that question.
 *
 * The withheld path is asserted too, because "a marketer sees no customer" is a claim about what the document
 * does NOT contain, and a render that simply omitted the section would satisfy a check for the wording while
 * leaving the table in place.
 */
const CONFLICT: LeaveConflictView = {
  appointmentId: '01a0e795-0000-7000-8000-000000000001',
  customerId: '01a0e795-0000-7000-8000-000000000002',
  customerDisplayName: null,
  serviceLabel: 'asian / normal_massage',
  roomCode: 'room-1',
  therapistReference: 'Therapist 07',
  startsAt: '2086-03-18 01:30',
  resolution: 'unresolved',
}

const view = (overrides: Partial<LeaveApprovalPageView> = {}): LeaveApprovalPageView => ({
  chrome: { googleReauth: null, returnTo: '/settings/integrations' },
  leaveRequestId: '01a0e795-0000-7000-8000-000000000003',
  therapistReference: 'Therapist 07',
  kind: 'annual',
  status: 'pending',
  startsAt: '2086-03-17 11:00',
  endsAt: '2086-03-18 02:00',
  fromTradingDate: '2086-03-17',
  toTradingDate: '2086-03-17',
  readAtIso: '2086-03-17T08:00:00.000Z',
  conflicts: [CONFLICT],
  breaches: [],
  preexistingBreachCount: 0,
  minimumTherapistsOnFloor: 2,
  coverageRuleEffectiveFrom: '2000-01-01',
  coverageOpenQuestionId: 'Y9-coverage',
  approval: null,
  access: {
    role: 'manager',
    mayApprove: true,
    mayOverride: true,
    maySeeConflicts: true,
  },
  direction: 'ltr',
  ...overrides,
})

describe('the document says what an operator has to act on', () => {
  it('prints both ends of the period, so the session alignment is visible', () => {
    const html = renderLeaveApprovalHtml(view())
    expect(html).toContain('2086-03-17 11:00 to 2086-03-18 02:00')
    // And the sentence that explains it, because the two instants alone look like a typo to somebody who
    // has not been told trading crosses midnight.
    expect(html).toContain('trading session')
  })

  it('prints every conflict with all five facts, and marks the unresolved ones', () => {
    const html = renderLeaveApprovalHtml(view())
    for (const field of ['customer', 'service', 'room', 'therapist', 'startsAt', 'resolution']) {
      expect(html, `the ${field} column is missing`).toContain(`data-field="${field}"`)
    }
    expect(html).toContain('data-conflicts="1"')
    expect(html).toContain('1 of them unresolved')
    expect(html).toContain('does not commit')
    expect(html).toContain('class="unresolved"')
  })

  it('names a customer nobody has named as unnamed, and never invents a label', () => {
    const html = renderLeaveApprovalHtml(view())
    expect(html).toContain('no name recorded')
    // The control: a recorded name IS printed, so the fallback is a fallback rather than the only path.
    const named = renderLeaveApprovalHtml(
      view({ conflicts: [{ ...CONFLICT, customerDisplayName: 'Customer 0042' }] }),
    )
    expect(named).toContain('Customer 0042')
    expect(named).not.toContain('no name recorded')
  })

  it('says on its face that approval never cancels a booking', () => {
    const html = renderLeaveApprovalHtml(view())
    expect(html).toContain('never cancels a booking')
    expect(html).toContain('never marks one a no-show')
  })

  it('names every breached segment, and reports a pre-existing shortfall separately', () => {
    const html = renderLeaveApprovalHtml(
      view({
        breaches: [
          { rule: 'minimum_floor_coverage', segmentLabel: '2086-03-17 11:00-11:30' },
          { rule: 'minimum_floor_coverage', segmentLabel: '2086-03-17 11:30-12:00' },
        ],
        preexistingBreachCount: 4,
      }),
    )
    expect(html).toContain('data-breaches="2"')
    expect(html).toContain('2086-03-17 11:00-11:30')
    expect(html).toContain('2086-03-17 11:30-12:00')
    // Separately, and worded as not being a reason to refuse: a manager told that six segments are short
    // when this leave caused two of them would go looking for four shifts that are nothing to do with it.
    expect(html).toContain('data-preexisting="4"')
    expect(html).toContain('already short without this leave')
  })

  it('prints the coverage minimum, the rule version and the open question beside them', () => {
    const html = renderLeaveApprovalHtml(view())
    expect(html).toContain('data-field="minimumOnFloor">2 therapist(s)')
    expect(html).toContain('data-field="coverageVersion">2000-01-01<')
    // docs/12 §2: a provisional figure is visible where it is USED, not only on the panel.
    expect(html).toContain('Y9-coverage')
    expect(html).toContain('provisional')
  })

  it('withholds the whole report from a reader who may not see a booking', () => {
    const html = renderLeaveApprovalHtml(
      view({
        access: {
          role: 'marketer',
          mayApprove: false,
          mayOverride: false,
          maySeeConflicts: false,
        },
      }),
    )
    expect(html).toContain('data-conflicts="withheld"')
    // The table is GONE, not emptied: a render that kept the rows and changed the wording would satisfy a
    // check for the sentence while printing the customer.
    expect(html).not.toContain('data-conflict>')
    expect(html).not.toContain(CONFLICT.customerId)
    // And the count is withheld with it, because a number is enough to tell somebody whether a named
    // colleague has bookings.
    expect(html).not.toContain('data-conflicts="1"')
  })

  it('offers no control at any role, and says why', () => {
    for (const role of ['owner', 'manager', 'therapist']) {
      const html = renderLeaveApprovalHtml(
        view({
          access: {
            role,
            mayApprove: role !== 'therapist',
            mayOverride: role !== 'therapist',
            maySeeConflicts: true,
          },
        }),
      )
      expect(html, role).not.toContain('<form')
      expect(html, role).not.toContain('<button')
      expect(html, role).toContain('Read-only.')
    }
  })

  it('is noindex, has no brand in the title, and mirrors on request', () => {
    const html = renderLeaveApprovalHtml(view())
    expect(html).toContain('<meta name="robots" content="noindex, nofollow, noarchive">')
    expect(html).toContain('<title>Leave request — HR admin</title>')
    expect(html).toContain('<html lang="en" dir="ltr">')
    expect(renderLeaveApprovalHtml(view({ direction: 'rtl' }))).toContain(
      '<html lang="en" dir="rtl">',
    )
  })

  it('prints the live approval when there is one, with the version that judged it', () => {
    const html = renderLeaveApprovalHtml(
      view({
        status: 'approved',
        approval: {
          approverRole: 'receptionist',
          approvedVia: 'delegation',
          coverageRuleEffectiveFrom: '2000-01-01',
          conflictsOverridden: 1,
          conflictsReassigned: 2,
        },
      }),
    )
    expect(html).toContain('data-approval')
    expect(html).toContain('delegated authority')
    expect(html).toContain('2 appointment(s) were reassigned and 1 overridden')
  })

  it('escapes what it prints, including a label somebody typed', () => {
    const html = renderLeaveApprovalHtml(
      view({
        conflicts: [{ ...CONFLICT, customerDisplayName: '<script>alert(1)</script>' }],
      }),
    )
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

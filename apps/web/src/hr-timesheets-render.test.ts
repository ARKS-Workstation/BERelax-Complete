import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  renderTimesheetsHtml,
  type TimesheetEmployeeView,
  type TimesheetPageView,
  type TimesheetVarianceView,
} from '../app/(admin)/hr/timesheets/render.ts'

/**
 * The timesheets document, without a server (P-HR-07).
 *
 * Everything the screen has to make visible is decidable from the markup, so there is no server here and no
 * port band claimed: a band declared and not used fails `ports.test.ts`, and a suite that started `next start`
 * to read a `<dl>` would be paying two minutes for what a string match answers.
 *
 * Every assertion has its control, because a renderer that prints nothing satisfies every "must not show"
 * claim on its own:
 *
 *   * "prints the incomplete count" is paired with the same document printing the payable total, because the
 *     whole point is that the two appear TOGETHER: 0 minutes on its own reads as somebody who never came in.
 *   * "never prints money" is paired with the weighted figure being present, so the document is asserted to
 *     be a timesheet rather than asserted to be empty.
 *   * "names the earliest OPEN date" is paired with the open-period branch printing no such date, so the
 *     sentence is a function of the data and not a constant left in the template.
 *   * "prints the punch times in Dubai" is paired with the UTC rendering of the same instant being ABSENT,
 *     which is the assertion `toISOString()` cannot satisfy by accident.
 */

/** 18:00–01:50 Dubai on the 3rd, which is the span the unit's whole subject turns on. */
const EVENING: TimesheetVarianceView = {
  tradingDate: '2026-08-03',
  outcome: 'EARLY_LEAVE',
  incompleteReason: null,
  lateByMinutes: 0,
  earlyLeaveByMinutes: 5,
  rosteredMinutes: 480,
  attendedMinutes: 470,
  clockedInAt: '18:00',
  clockedOutAt: '01:50',
  clockOutWasCorrected: false,
}

const INCOMPLETE: TimesheetVarianceView = {
  tradingDate: '2026-08-04',
  outcome: 'INCOMPLETE',
  incompleteReason: 'missing_clock_out',
  lateByMinutes: 0,
  earlyLeaveByMinutes: 0,
  rosteredMinutes: 480,
  attendedMinutes: 0,
  clockedInAt: '18:00',
  clockedOutAt: null,
  clockOutWasCorrected: false,
}

function employee(overrides: Partial<TimesheetEmployeeView> = {}): TimesheetEmployeeView {
  return {
    staffReference: 'Therapist 07',
    variances: [EVENING, INCOMPLETE],
    corrections: [],
    payableMinutes: 470,
    weightedMinuteBp: 5_050_000,
    incompletePresenceCount: 1,
    unrosteredPresenceCount: 0,
    approval: null,
    ...overrides,
  }
}

function view(overrides: Partial<TimesheetPageView> = {}): TimesheetPageView {
  return {
    chrome: { googleReauth: null, returnTo: '/hr/timesheets' },
    readAtIso: '2026-08-10T06:00:00.000Z',
    fromTradingDate: '2026-08-03',
    toTradingDate: '2026-08-09',
    rotaVersion: { id: '01a0dcab-0000-7000-8000-000000000000', versionNo: 3 },
    employees: [employee()],
    grace: {
      effectiveFrom: '1900-01-01',
      openQuestionId: 'Y9-attendance',
      graceMinutesAfterStart: 5,
      graceMinutesBeforeEnd: 5,
      maximumPlausiblePresenceMinutes: 720,
      punchToleranceMinutes: 120,
      captureMethod: 'manual_front_desk',
    },
    accountingPeriod: { closed: false, periodId: null, earliestOpenDate: '2026-08-03' },
    ...overrides,
  }
}

describe('the timesheets document', () => {
  it('prints the payable total and the incomplete count together, never one alone', () => {
    const html = renderTimesheetsHtml(view())
    expect(html).toContain('7h 50m')
    expect(html).toContain('470 minutes')
    // The count is unconditional, for `rota_version.forecast_unpriced_employees`'s reason: a week where every
    // clock-out was missed is 0 payable minutes and reads as a therapist who never came in.
    expect(html).toContain('1 span(s) contributed nothing')
  })

  it('CONTROL: a period with nothing incomplete still prints the count, as zero', () => {
    const html = renderTimesheetsHtml(
      view({
        employees: [employee({ variances: [EVENING], incompletePresenceCount: 0 })],
      }),
    )
    expect(html).toContain('0 span(s) contributed nothing')
  })

  it('prints punch times in the emirates zone, and never the UTC rendering of the same instant', () => {
    const html = renderTimesheetsHtml(view())
    // 01:50 Dubai is 21:50 UTC the previous day. A renderer reaching for `toISOString().slice(11, 16)` would
    // print 21:50 here, and the figure would look ordinary — so both halves are asserted.
    expect(html).toContain('18:00–01:50')
    expect(html).not.toContain('21:50')
  })

  it('says WHY a span is incomplete rather than only that it is', () => {
    const html = renderTimesheetsHtml(view())
    expect(html).toContain(
      'no clock-out, so it is unpriced until an audited correction supplies one',
    )
    const implausible = renderTimesheetsHtml(
      view({
        employees: [
          employee({
            variances: [
              { ...INCOMPLETE, incompleteReason: 'implausible_span', clockedOutAt: '09:00' },
            ],
          }),
        ],
      }),
    )
    // The other branch, so the sentence is a function of the reason rather than a constant in the template.
    expect(implausible).toContain('too far apart to be one presence')
    expect(implausible).not.toContain('no clock-out, so it is unpriced')
  })

  it('names the published version the variance was measured against', () => {
    expect(renderTimesheetsHtml(view())).toContain('published rota version 3')
  })

  it('refuses to show a variance at all when no version covers the period', () => {
    const html = renderTimesheetsHtml(view({ rotaVersion: null }))
    // Not an empty screen: a period with no published version is the one state in which every day would come
    // back UNROSTERED, and rendering that silently would be a claim nobody made.
    expect(html).toContain('No published rota covers this period, so no variance can be computed')
    expect(html).not.toContain('published rota version')
  })

  it('names the earliest OPEN date when the accounting period is closed, and no date when it is open', () => {
    const closed = renderTimesheetsHtml(
      view({
        accountingPeriod: { closed: true, periodId: '2026-08', earliestOpenDate: '2026-09-01' },
      }),
    )
    // Naming only the lock sends somebody to a month they also cannot use, which is why 0073 redefined the
    // refusal to carry both.
    expect(closed).toContain('2026-08')
    expect(closed).toContain('2026-09-01')
    expect(closed).toContain('earliest OPEN date')
    const open = renderTimesheetsHtml(view())
    expect(open).toContain('accounting period covering these dates is open')
    expect(open).not.toContain('earliest OPEN date')
  })

  it('prints both deviations when a span is late AND short, because the badge shows one', () => {
    const html = renderTimesheetsHtml(
      view({
        employees: [
          employee({
            variances: [
              { ...EVENING, outcome: 'LATE', lateByMinutes: 40, earlyLeaveByMinutes: 55 },
            ],
          }),
        ],
      }),
    )
    expect(html).toContain('40m late')
    expect(html).toContain('55m early')
  })

  it('shows every correction with its reason and its adjustment date', () => {
    const html = renderTimesheetsHtml(
      view({
        employees: [
          employee({
            corrections: [
              {
                tradingDate: '2026-08-04',
                adjustmentDate: '2026-09-01',
                kind: 'supply_missing_clock_out',
                reason: 'Front desk confirmed she left at 02:00.',
                correctedBy: 'HR administrator',
              },
            ],
          }),
        ],
      }),
    )
    expect(html).toContain('supply_missing_clock_out')
    expect(html).toContain('adjusted on 2026-09-01')
    expect(html).toContain('Front desk confirmed she left at 02:00.')
  })

  it('marks a clock-out that came from a correction rather than from a punch', () => {
    const html = renderTimesheetsHtml(
      view({
        employees: [
          employee({
            variances: [{ ...EVENING, clockOutWasCorrected: true }],
          }),
        ],
      }),
    )
    expect(html).toContain('clock-out supplied by a correction')
    // CONTROL: the uncorrected document says nothing of the kind, so the phrase is data-driven.
    expect(renderTimesheetsHtml(view())).not.toContain('supplied by a correction')
  })

  it('says whether the period is approved, and that a correction is the only change afterwards', () => {
    const approved = renderTimesheetsHtml(
      view({
        employees: [
          employee({
            approval: {
              approvedAtIso: '2026-08-10T05:00:00.000Z',
              approvedBy: 'HR administrator',
              payableMinutes: 470,
            },
          }),
        ],
      }),
    )
    expect(approved).toContain('Approved')
    expect(approved).toContain('the only change is a dated correction')
    expect(renderTimesheetsHtml(view())).toContain('Not approved')
  })

  it('states the provisional figures and the question that settles them', () => {
    const html = renderTimesheetsHtml(view())
    expect(html).toContain('Every figure below is provisional')
    expect(html).toContain('Y9-attendance')
    // Every figure, on the face of the screen, because docs/12 §2 wants a provisional value visible where it
    // is USED and not only on the assumptions panel.
    expect(html).toContain('5 minute(s) after the rostered start')
    expect(html).toContain('12h 0m')
    expect(html).toContain('120 minute(s) outside the trading window')
    // And that capture is manual, which is itself an answer somebody has to confirm.
    expect(html).toContain('manual_front_desk')
    expect(html).toContain('no biometric reader')
  })

  it('never prints money, and does print the weighted minutes it prints instead', () => {
    const html = renderTimesheetsHtml(view())
    // What an hour of a monthly wage is worth is unanswered (Y9-overtime), so a dirham figure here would be
    // that answer invented. The paired assertion is what stops this passing over an empty document.
    expect(html).toContain('5050000 basis-point-minutes')
    expect(html).not.toContain('AED')
    expect(html).not.toMatch(/\bfils\b/)
  })

  it('names no person, and does name the handle and the outcomes', () => {
    const html = renderTimesheetsHtml(view())
    expect(html).toContain('Therapist 07')
    expect(html).toContain('EARLY_LEAVE')
    expect(html).toContain('INCOMPLETE')
    // Nineteen employees have no name recorded (ADR 0020, brief rule 10), so the screen shows the internal
    // handle. `staff_reference` is what a name would displace.
    expect(html).not.toMatch(/\b(?:Aisha|Fatima|Priya|Maria|Nadia)\b/)
  })

  it('the route derives a punch’s wall clock through toLocal and never through toISOString', () => {
    // The route is the surface where this would be read by a person rather than by an assertion, and
    // `toISOString().slice(11, 16)` reports 21:50 for a 01:50-Dubai clock-out — the previous day, at the wrong
    // time. P-HR-06 had a test pass for exactly that reason. Asserted against the SOURCE because the route
    // needs a database and this file does not start one: the claim is about which function is called, and
    // there is no input that makes the two agree.
    const route = readFileSync(
      join(import.meta.dirname, '..', 'app', '(admin)', 'hr', 'timesheets', 'route.ts'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '')
    expect(route).toContain('return toLocal(instant).time')
    expect(route).not.toMatch(/toISOString\(\)\.slice\(11/)
  })

  it('writes no opening or closing time of its own, which premises.test.ts refuses anyway', () => {
    // The hours live in `premises_hours` and every consumer formats them; a literal here is a second source of
    // truth that goes on showing the old time after an owner changes it. The punch times ARE on the page and
    // they come from the data.
    const html = renderTimesheetsHtml(view())
    expect(html).not.toContain('11:00–02:00')
    expect(html).not.toContain('11:00 - 02:00')
  })
})

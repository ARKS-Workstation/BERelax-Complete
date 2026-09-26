import { describe, expect, it } from 'vitest'
import {
  ATTENDANCE_OUTCOMES,
  type AttendanceCorrection,
  type AttendanceGraceRules,
  type AttendanceOutcome,
  type AttendancePunch,
  applyAttendanceCorrections,
  attendanceGraceFor,
  deriveAttendanceVariance,
  describeAttendanceInstant,
  fromLocal,
  type Instant,
  type LocalDate,
  localDate,
  localTime,
  pairAttendancePunches,
  payablePresences,
  type RosteredSpan,
  summariseTimesheet,
  toLocal,
  type WorkingHoursRules,
} from '../index.ts'

/**
 * P-HR-07 — attendance variance, the INCOMPLETE presence, and the payable minutes.
 *
 * ## What each block is a control for
 *
 * The acceptance criterion asks for a table-driven derivation with one case per outcome, and a table of
 * cases is exactly the shape that goes vacuous quietly: every row asserts "the outcome is what I expected"
 * and nothing asserts that a row could have come out differently. So the table below is paired with two
 * controls that must fail, and both are asserted:
 *
 *   1. **The grace window is an ARGUMENT and it moves the answer.** The LATE row is re-run against a version
 *      whose window is wide enough to absorb the lateness and must come back ON_TIME. A derivation with a
 *      literal 5 in it passes the table and fails this.
 *   2. **Every outcome in `ATTENDANCE_OUTCOMES` is exercised.** Asserted by set equality against the table's
 *      own expectations, so a sixth outcome added to the vocabulary and not to the table fails here rather
 *      than being silently untested.
 *
 * ## The date assertion measures the emirate and not the machine
 *
 * `toISOString()` on a 00:00-Dubai instant reports the PREVIOUS calendar day, and P-HR-06 had a case pass
 * for exactly that wrong reason. So the 01:50 case asserts `describeAttendanceInstant`, which carries the
 * local TIME beside the local date: 01:50 Dubai is 21:50 UTC the day before, so the two renderings agree on
 * neither field and a UTC implementation cannot satisfy the assertion by accident. The control for it is in
 * the same block and asserts that the UTC rendering DISAGREES — which is the half that makes the first
 * assertion mean something.
 */

const GRACE: AttendanceGraceRules = {
  effectiveFrom: localDate('1900-01-01'),
  graceMinutesAfterStart: 5,
  graceMinutesBeforeEnd: 5,
  maximumPlausiblePresenceMinutes: 720,
  punchToleranceMinutes: 120,
}

/** The version that would absorb a 40-minute lateness. Control 1's other arm, and nothing else uses it. */
const FORGIVING: AttendanceGraceRules = {
  ...GRACE,
  effectiveFrom: localDate('1900-01-01'),
  graceMinutesAfterStart: 60,
  graceMinutesBeforeEnd: 60,
}

/**
 * P-HR-05's version 1 figures, restated rather than imported from the database.
 *
 * Eight ordinary hours, a 22:00–04:00 night window and 11 hours' rest, which are `working_hours_rule`
 * version 1's. Restated because this file is pure and `packages/core` reads nothing; the INTEGRATION suite
 * asserts the same arithmetic against the real rows, which is the half a pure file cannot make.
 */
const RATES: WorkingHoursRules = {
  effectiveFrom: localDate('1900-01-01'),
  ordinaryMinutesPerDay: 480,
  ordinaryMinutesPerWeek: 2880,
  weekStartsOn: 1,
  overtimeDailyCapMinutes: 120,
  minimumRestMinutes: 660,
  nightWindow: { from: localTime('22:00'), until: localTime('04:00') },
  multiplierBp: { ordinary: 10_000, overtime: 12_500, night: 15_000, publicHoliday: 15_000 },
}

const DAY = localDate('2026-07-13')
const NEXT = localDate('2026-07-14')
const WORKER = 'employee-one'

/** An instant from a Dubai wall clock. Never `Date.parse` of a bare string, which reads as UTC. */
const at = (date: LocalDate, time: string): Instant => fromLocal(date, localTime(time))

let sequence = 0
function punch(
  kind: 'clock_in' | 'clock_out',
  time: string,
  date: LocalDate = DAY,
): AttendancePunch {
  sequence += 1
  return {
    eventId: `event-${sequence}`,
    employeeId: WORKER,
    tradingDate: DAY,
    kind,
    occurredAt: at(date, time),
    correctionId: null,
  }
}

/** The rostered evening band, 18:00–02:00, which is the shift that crosses midnight. */
const EVENING: RosteredSpan = {
  employeeId: WORKER,
  tradingDate: DAY,
  startsAt: at(DAY, '18:00'),
  endsAt: at(NEXT, '02:00'),
}

const varianceOf = (args: {
  readonly rostered?: readonly RosteredSpan[]
  readonly punches: readonly AttendancePunch[]
  readonly corrections?: readonly AttendanceCorrection[]
  readonly rules?: AttendanceGraceRules
}) =>
  deriveAttendanceVariance({
    rostered: args.rostered ?? [EVENING],
    punches: args.punches,
    corrections: args.corrections ?? [],
    graceRuleVersions: [args.rules ?? GRACE],
  })

// ---------------------------------------------------------------------------------------------
// The table: one case per outcome, and the grace window supplied as an argument
// ---------------------------------------------------------------------------------------------

interface VarianceCase {
  readonly name: string
  readonly expected: AttendanceOutcome
  readonly rostered: readonly RosteredSpan[]
  readonly punches: () => readonly AttendancePunch[]
  /** What the row also proves, beyond the outcome. Every row has one — an outcome alone is half a claim. */
  readonly also: (row: ReturnType<typeof varianceOf>[number]) => void
}

const CASES: readonly VarianceCase[] = [
  {
    name: 'both ends inside the grace windows',
    expected: 'ON_TIME',
    rostered: [EVENING],
    punches: () => [punch('clock_in', '18:04'), punch('clock_out', '01:57', NEXT)],
    also: (row) => {
      expect(row.lateByMinutes).toBe(0)
      expect(row.earlyLeaveByMinutes).toBe(0)
      // 18:04 to 01:57 is 7h53m. Asserted arithmetically: a wall-clock subtraction would make it negative.
      expect(row.attendedMinutes).toBe(473)
      expect(row.rosteredMinutes).toBe(480)
    },
  },
  {
    name: 'clocked in 45 minutes after the rostered start',
    expected: 'LATE',
    rostered: [EVENING],
    punches: () => [punch('clock_in', '18:45'), punch('clock_out', '02:00', NEXT)],
    also: (row) => {
      // 45 minutes late MINUS the 5-minute grace window, which is the figure the criterion is about.
      expect(row.lateByMinutes).toBe(40)
      expect(row.earlyLeaveByMinutes).toBe(0)
    },
  },
  {
    name: 'clocked out 30 minutes before the rostered end',
    expected: 'EARLY_LEAVE',
    rostered: [EVENING],
    punches: () => [punch('clock_in', '18:00'), punch('clock_out', '01:30', NEXT)],
    also: (row) => {
      expect(row.lateByMinutes).toBe(0)
      expect(row.earlyLeaveByMinutes).toBe(25)
    },
  },
  {
    name: 'rostered and no punch at all',
    expected: 'ABSENT',
    rostered: [EVENING],
    punches: () => [],
    also: (row) => {
      expect(row.attendedMinutes).toBe(0)
      expect(row.presences).toHaveLength(0)
      // The rostered minutes survive an absence, because "she was down for eight hours and did not come" is
      // the fact. A row reporting zero on both sides could not tell an absence from a day off.
      expect(row.rosteredMinutes).toBe(480)
    },
  },
  {
    name: 'punched on a day the published rota rostered nobody',
    expected: 'UNROSTERED',
    rostered: [],
    punches: () => [punch('clock_in', '12:00'), punch('clock_out', '16:00')],
    also: (row) => {
      expect(row.rosteredMinutes).toBe(0)
      expect(row.lateByMinutes).toBe(0)
      // Payable, and that is the strict reading in the direction that matters: not paying somebody who
      // worked is the non-compliant error, and paying somebody the rota did not expect is a flag.
      expect(row.attendedMinutes).toBe(240)
    },
  },
  {
    name: 'clocked in and never clocked out',
    expected: 'INCOMPLETE',
    rostered: [EVENING],
    punches: () => [punch('clock_in', '18:00')],
    also: (row) => {
      expect(row.incompleteReason).toBe('missing_clock_out')
      expect(row.attendedMinutes).toBe(0)
      // The clock-in is still known, so the row carries what it can: this one was on time to arrive.
      expect(row.lateByMinutes).toBe(0)
      expect(row.presences[0]?.endsAt).toBeNull()
    },
  },
]

describe('acceptance — variance derivation, one case per outcome, grace window as an argument', () => {
  for (const testCase of CASES) {
    it(`${testCase.expected}: ${testCase.name}`, () => {
      const rows = varianceOf({ rostered: testCase.rostered, punches: testCase.punches() })
      expect(rows).toHaveLength(1)
      const row = rows[0] as (typeof rows)[number]
      expect(row.outcome).toBe(testCase.expected)
      testCase.also(row)
    })
  }

  it('INCOMPLETE beats UNROSTERED, so an unpriceable span never reaches the pricing', () => {
    // The ordering this asserts was WRONG in the first version of the module and only the integration run
    // found it: `UNROSTERED` first made an unrostered presence with no clock-out a PAYABLE row with an
    // unknown end, `payablePresences` threw its structural guard, and a 503 reached the timesheet screen for
    // an ordinary case — somebody clocked in with nothing rostered and forgot to clock out.
    const rows = varianceOf({ rostered: [], punches: [punch('clock_in', '12:00')] })
    const row = rows[0] as (typeof rows)[number]
    expect(row.outcome).toBe('INCOMPLETE')
    expect(row.incompleteReason).toBe('missing_clock_out')
    // Nothing is lost by the order: the row still says the rota rostered nobody for it.
    expect(row.rosteredMinutes).toBe(0)
    // And the guard is unreachable rather than merely unfired, which is the point of the ordering.
    expect(payablePresences(rows)).toHaveLength(0)
  })

  it('matches an open presence to the span it arrived early for, not to nothing', () => {
    // A clock-in eight minutes before an 11:00 shift, with no clock-out. Treating the open presence as one
    // minute wide — which this module did first — made it overlap nothing, so the day came back UNROSTERED
    // rather than as the incomplete shift it is, and the rostered span was reported ABSENT beside it.
    const morning: RosteredSpan = {
      employeeId: WORKER,
      tradingDate: DAY,
      startsAt: at(DAY, '11:00'),
      endsAt: at(DAY, '19:00'),
    }
    const rows = varianceOf({ rostered: [morning], punches: [punch('clock_in', '10:52')] })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.outcome).toBe('INCOMPLETE')
    // Matched to the span, so the rostered minutes are on the row and no phantom ABSENT accompanies it.
    expect(rows[0]?.rosteredMinutes).toBe(480)
    expect(rows.filter((row) => row.outcome === 'ABSENT')).toHaveLength(0)
  })

  it('exercises every outcome in the vocabulary, so a new one cannot arrive untested', () => {
    expect(new Set(CASES.map((testCase) => testCase.expected))).toEqual(
      new Set(ATTENDANCE_OUTCOMES),
    )
  })

  it('CONTROL: the grace window moves the answer, so it is not a literal in the derivation', () => {
    const punches = [punch('clock_in', '18:45'), punch('clock_out', '02:00', NEXT)]
    const strict = varianceOf({ punches })
    const forgiving = varianceOf({ punches, rules: FORGIVING })
    expect(strict[0]?.outcome).toBe('LATE')
    expect(strict[0]?.lateByMinutes).toBe(40)
    // Same punches, same roster, a wider window: the same arrival is now on time and the figure is zero.
    expect(forgiving[0]?.outcome).toBe('ON_TIME')
    expect(forgiving[0]?.lateByMinutes).toBe(0)
  })

  it('reports BOTH deviations on a span that is late and short, with LATE taking precedence', () => {
    const rows = varianceOf({
      punches: [punch('clock_in', '18:45'), punch('clock_out', '01:00', NEXT)],
    })
    const row = rows[0] as (typeof rows)[number]
    // The precedence chooses one badge and hides no number, which is the claim the module's header makes.
    expect(row.outcome).toBe('LATE')
    expect(row.lateByMinutes).toBe(40)
    expect(row.earlyLeaveByMinutes).toBe(55)
  })

  it('refuses a version table that does not reach the trading date', () => {
    expect(() =>
      deriveAttendanceVariance({
        rostered: [EVENING],
        punches: [punch('clock_in', '18:00'), punch('clock_out', '02:00', NEXT)],
        corrections: [],
        graceRuleVersions: [{ ...GRACE, effectiveFrom: localDate('2030-01-01') }],
      }),
    ).toThrow(/takes effect on or before 2026-07-13/)
  })
})

// ---------------------------------------------------------------------------------------------
// business_day attribution, measured in the emirate's zone
// ---------------------------------------------------------------------------------------------

describe('acceptance — a 01:50 clock-out belongs to the day that opened at 11:00', () => {
  it('keeps the punch on the trading date it was filed under and renders the local time beside it', () => {
    const out = punch('clock_out', '01:50', NEXT)
    // The CALENDAR date of the instant is the 14th and its TRADING date is the 13th. Both asserted, because
    // asserting only one of them cannot tell a correct attribution from a timezone slip.
    expect(toLocal(out.occurredAt).date).toBe('2026-07-14')
    expect(out.tradingDate).toBe('2026-07-13')
    expect(describeAttendanceInstant(out.occurredAt, out.tradingDate)).toBe(
      '2026-07-14 01:50 (trading date 2026-07-13)',
    )
  })

  it('CONTROL: the UTC rendering disagrees on both fields, so the assertion above measures Dubai', () => {
    const out = punch('clock_out', '01:50', NEXT)
    // 01:50 Dubai is 21:50 UTC the previous day. A `toISOString()` implementation would produce
    // "2026-07-13 21:50", which agrees with neither the date nor the time asserted above — which is what
    // makes that assertion a measurement of the emirate rather than of the machine.
    const asUtc = new Date(out.occurredAt).toISOString()
    expect(asUtc.slice(0, 10)).toBe('2026-07-13')
    expect(asUtc.slice(11, 16)).toBe('21:50')
    expect(describeAttendanceInstant(out.occurredAt, out.tradingDate)).not.toContain('21:50')
  })

  it('prices a shift that crosses midnight by subtracting instants, not wall clocks', () => {
    const rows = varianceOf({
      punches: [punch('clock_in', '18:00'), punch('clock_out', '01:50', NEXT)],
    })
    // 18:00 to 01:50 is 470 minutes. A wall-clock subtraction reads it as -970.
    expect(rows[0]?.attendedMinutes).toBe(470)
    // And 01:50 against a rostered 02:00 is ten minutes early, five of them inside the grace window — which
    // is the same subtraction done across midnight in the other direction. The first version of this case
    // expected ON_TIME and was simply wrong about its own fixture; the arithmetic it exists for is the 470.
    expect(rows[0]?.outcome).toBe('EARLY_LEAVE')
    expect(rows[0]?.earlyLeaveByMinutes).toBe(5)
  })
})

// ---------------------------------------------------------------------------------------------
// INCOMPLETE contributes nothing, and never an implausible shift
// ---------------------------------------------------------------------------------------------

describe('acceptance — an INCOMPLETE presence contributes zero payable minutes', () => {
  const timesheetOf = (args: {
    readonly punches: readonly AttendancePunch[]
    readonly corrections?: readonly AttendanceCorrection[]
    readonly rostered?: readonly RosteredSpan[]
  }) =>
    summariseTimesheet({
      employeeId: WORKER,
      fromTradingDate: DAY,
      toTradingDate: DAY,
      rostered: args.rostered ?? [EVENING],
      punches: args.punches,
      corrections: args.corrections ?? [],
      graceRuleVersions: [GRACE],
      workingHoursRuleVersions: [RATES],
    })

  it('excludes it from the minutes computation rather than truncating it at close', () => {
    const summary = timesheetOf({ punches: [punch('clock_in', '18:00')] })
    expect(summary.payableMinutes).toBe(0)
    expect(summary.weightedMinuteBp).toBe(0)
    expect(summary.incompletePresenceCount).toBe(1)
    // The presence is ABSENT from what P-HR-05 was given, which is what makes the zero structural: there is
    // no subtraction to forget and no truncation to get wrong.
    expect(summary.workedHours.days).toHaveLength(0)
    expect(payablePresences(summary.variances)).toHaveLength(0)
  })

  it('never yields an implausible >12h shift from a clock-out punched the next morning', () => {
    // Clocked in at 18:00 and out at 09:00 the following morning: fifteen hours, which is not one presence.
    // It is inside the trading day's widened window, so the database attributes it to this trading date and
    // the pair is representable — which is exactly why the disbelief has to happen in the arithmetic.
    const summary = timesheetOf({
      punches: [punch('clock_in', '18:00'), punch('clock_out', '09:00', NEXT)],
    })
    const row = summary.variances[0] as (typeof summary.variances)[number]
    expect(row.outcome).toBe('INCOMPLETE')
    expect(row.incompleteReason).toBe('implausible_span')
    expect(summary.payableMinutes).toBe(0)
    // The claim in the acceptance criterion's own terms, asserted as a number rather than as a verdict.
    for (const day of summary.workedHours.days) expect(day.totalMinutes).toBeLessThanOrEqual(720)
  })

  it('contributes nothing even for the part of the span that WAS closed', () => {
    // A morning presence that closed cleanly and an afternoon one that did not. The span's total is unknown,
    // so no part of it can be priced without deciding what the rest was — and 120 attended minutes on a day
    // that paid nothing is the figure a therapist would query and nobody could explain.
    //
    // This case exists because a gate case measured nothing without it. 113d mutates `attendedMinutes` to
    // report the believed minutes unconditionally, and over a span with ONE unclosed presence that is a no-op:
    // the believed total is zero either way. Only a span holding both kinds can tell the two apart.
    const summary = timesheetOf({
      punches: [
        punch('clock_in', '18:00'),
        punch('clock_out', '20:00'),
        punch('clock_in', '21:00'),
      ],
    })
    const row = summary.variances[0] as (typeof summary.variances)[number]
    expect(row.outcome).toBe('INCOMPLETE')
    expect(row.incompleteReason).toBe('missing_clock_out')
    expect(row.presences).toHaveLength(2)
    // The closed presence is worth 120 minutes and the row reports zero, which is the claim.
    expect(row.attendedMinutes).toBe(0)
    expect(summary.payableMinutes).toBe(0)
  })

  it('CONTROL: the same pair one minute inside the plausible span IS priced', () => {
    // 18:00 to 06:00 is exactly 720 minutes, which the rule permits — the comparison is `>` and not `>=`, so
    // a presence exactly at the figure is believed. Without this arm, an implementation that disbelieved
    // everything over eight hours would pass the case above.
    const summary = timesheetOf({
      punches: [punch('clock_in', '18:00'), punch('clock_out', '06:00', NEXT)],
    })
    expect(summary.variances[0]?.outcome).not.toBe('INCOMPLETE')
    expect(summary.payableMinutes).toBe(720)
  })

  it('an audited correction supplying the clock-out makes the presence payable', () => {
    const clockIn = punch('clock_in', '18:00')
    const correction: AttendanceCorrection = {
      correctionId: 'correction-one',
      employeeId: WORKER,
      tradingDate: DAY,
      adjustmentDate: localDate('2026-08-03'),
      kind: 'supply_missing_clock_out',
      correctsEventId: clockIn.eventId,
      correctedOccurredAt: at(NEXT, '02:00'),
    }
    const before = timesheetOf({ punches: [clockIn] })
    const after = timesheetOf({ punches: [clockIn], corrections: [correction] })
    expect(before.payableMinutes).toBe(0)
    expect(after.payableMinutes).toBe(480)
    expect(after.variances[0]?.outcome).toBe('ON_TIME')
    // The supplied punch says where it came from, so a screen can mark the day as corrected rather than
    // showing a figure that silently differs from the punches underneath it.
    expect(after.variances[0]?.presences[0]?.clockOutEventId).toBe('correction:correction-one')
  })
})

// ---------------------------------------------------------------------------------------------
// Payable minutes ARE P-HR-05's buckets
// ---------------------------------------------------------------------------------------------

describe('acceptance — payable minutes equal the sum of the P-HR-05 buckets', () => {
  it('sums to the buckets exactly, over a week whose days hit three of the four', () => {
    // Monday evening 18:00-02:00 crosses the night window and the eight-hour boundary at once, so this one
    // week produces ordinary, night and overtime minutes — which is what makes the equality worth asserting
    // rather than trivially true over a single ordinary day.
    const monday = localDate('2026-07-13')
    const wednesday = localDate('2026-07-15')
    const spans: RosteredSpan[] = [
      {
        employeeId: WORKER,
        tradingDate: monday,
        startsAt: at(monday, '16:00'),
        endsAt: at(localDate('2026-07-14'), '02:00'),
      },
      {
        employeeId: WORKER,
        tradingDate: wednesday,
        // 11:00-21:00, and the two extra hours are what puts minutes in the OVERTIME bucket: they are past
        // the eight-hour allowance and before the 22:00 night window, so nothing dearer applies to them.
        // The first version of this fixture ran 11:00-19:00 and produced only two buckets, which is the
        // measured reason the arm count below is asserted rather than assumed.
        startsAt: at(wednesday, '11:00'),
        endsAt: at(wednesday, '21:00'),
      },
    ]
    const punches: AttendancePunch[] = [
      { ...punch('clock_in', '16:00', monday), tradingDate: monday },
      { ...punch('clock_out', '02:00', localDate('2026-07-14')), tradingDate: monday },
      { ...punch('clock_in', '11:00', wednesday), tradingDate: wednesday },
      { ...punch('clock_out', '21:00', wednesday), tradingDate: wednesday },
    ]
    const summary = summariseTimesheet({
      employeeId: WORKER,
      fromTradingDate: monday,
      toTradingDate: localDate('2026-07-19'),
      rostered: spans,
      punches,
      corrections: [],
      graceRuleVersions: [GRACE],
      workingHoursRuleVersions: [RATES],
    })

    let bucketTotal = 0
    const seen = new Set<string>()
    for (const day of summary.workedHours.days) {
      for (const [bucket, minutes] of Object.entries(day.minutes)) {
        bucketTotal += minutes
        if (minutes > 0) seen.add(bucket)
      }
    }
    expect(summary.payableMinutes).toBe(bucketTotal)
    expect(summary.payableMinutes).toBe(600 + 600)
    // The fixture has to be able to exercise the claim, and this arm is MEASURED rather than hoped for: the
    // first version of this week produced exactly two non-empty buckets, so the equality held over a
    // partition of two and said nothing about the third. Three is the floor the corrected fixture reaches.
    expect(seen.size).toBe(3)
    expect(seen).toEqual(new Set(['ordinary', 'night', 'overtime']))
  })

  it('CONTROL: the figure follows the ATTENDANCE and not the roster it was measured against', () => {
    // The defect worth catching is a payable total taken from the ROSTER — which is what a timesheet looks
    // like to anybody who has not thought about it, pays the rota rather than the hours, and reads as
    // perfectly ordinary on a screen. So the fixture is a week where attendance and roster cannot agree: one
    // day short by 37 minutes and one day INCOMPLETE, which contributes nothing at all.
    const clockIn = punch('clock_in', '18:00')
    const summary = summariseTimesheet({
      employeeId: WORKER,
      fromTradingDate: DAY,
      toTradingDate: NEXT,
      rostered: [
        EVENING,
        {
          employeeId: WORKER,
          tradingDate: NEXT,
          startsAt: at(NEXT, '11:00'),
          endsAt: at(NEXT, '19:00'),
        },
      ],
      punches: [
        clockIn,
        { ...punch('clock_in', '11:00', NEXT), tradingDate: NEXT },
        { ...punch('clock_out', '18:23', NEXT), tradingDate: NEXT },
      ],
      corrections: [],
      graceRuleVersions: [GRACE],
      workingHoursRuleVersions: [RATES],
    })
    expect(summary.variances.map((row) => row.outcome)).toEqual(['INCOMPLETE', 'EARLY_LEAVE'])
    const rosteredTotal = summary.variances.reduce((total, row) => total + row.rosteredMinutes, 0)
    expect(rosteredTotal).toBe(960)
    // 11:00 to 18:23 is 443 minutes, and the incomplete day contributes nothing.
    expect(summary.payableMinutes).toBe(443)
    expect(summary.payableMinutes).not.toBe(rosteredTotal)
    // The weighted figure is the buckets' and not the minutes' — 443 daytime minutes at the ordinary
    // multiplier, which no reading of the roster total produces.
    expect(summary.weightedMinuteBp).toBe(443 * 10_000)
    expect(summary.incompletePresenceCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------------------------
// Pairing, and the structural refusals
// ---------------------------------------------------------------------------------------------

describe('pairing punches', () => {
  it('pairs in and out chronologically and leaves a trailing clock-in open', () => {
    const presences = pairAttendancePunches([
      punch('clock_in', '18:00'),
      punch('clock_out', '20:00'),
      punch('clock_in', '21:00'),
    ])
    expect(presences).toHaveLength(2)
    expect(presences[0]?.endsAt).not.toBeNull()
    expect(presences[1]?.endsAt).toBeNull()
  })

  it('refuses two clock-ins with no clock-out between them', () => {
    expect(() =>
      pairAttendancePunches([punch('clock_in', '18:00'), punch('clock_in', '19:00')]),
    ).toThrow(/two clock-ins/)
  })

  it('refuses a clock-out with no clock-in open', () => {
    expect(() => pairAttendancePunches([punch('clock_out', '19:00')])).toThrow(/no clock-in open/)
  })

  it('treats a lunch break as one span with two presences, neither late nor early', () => {
    const rows = varianceOf({
      punches: [
        punch('clock_in', '18:00'),
        punch('clock_out', '20:00'),
        punch('clock_in', '21:00'),
        punch('clock_out', '02:00', NEXT),
      ],
    })
    expect(rows).toHaveLength(1)
    const row = rows[0] as (typeof rows)[number]
    expect(row.outcome).toBe('ON_TIME')
    expect(row.presences).toHaveLength(2)
    // 120 + 300 minutes attended: the hour clocked out for is not paid, which is what clocking out means.
    expect(row.attendedMinutes).toBe(420)
    expect(row.rosteredMinutes).toBe(480)
  })

  it('reports a morning-plus-evening roster as two spans and does not refuse the day', () => {
    const morning: RosteredSpan = {
      employeeId: WORKER,
      tradingDate: DAY,
      startsAt: at(DAY, '11:00'),
      endsAt: at(DAY, '15:00'),
    }
    const rows = varianceOf({
      rostered: [morning, EVENING],
      punches: [punch('clock_in', '11:00'), punch('clock_out', '15:00')],
    })
    // The morning was worked and the evening was not. A derivation that refused the day for having no single
    // rostered start would lose both facts, and one that took the first span would report the evening as
    // attended.
    expect(rows.map((row) => row.outcome)).toEqual(['ON_TIME', 'ABSENT'])
    expect(rows[1]?.rosteredMinutes).toBe(480)
  })
})

describe('corrections layered over punches', () => {
  it('amends a punch in place, keeping its own event id and naming the correction', () => {
    const out = punch('clock_out', '01:00', NEXT)
    const corrected = applyAttendanceCorrections(
      [punch('clock_in', '18:00'), out],
      [
        {
          correctionId: 'correction-two',
          employeeId: WORKER,
          tradingDate: DAY,
          adjustmentDate: localDate('2026-08-03'),
          kind: 'amend_punch_instant',
          correctsEventId: out.eventId,
          correctedOccurredAt: at(NEXT, '02:00'),
        },
      ],
    )
    const amended = corrected.find((row) => row.eventId === out.eventId)
    expect(amended?.occurredAt).toBe(at(NEXT, '02:00'))
    expect(amended?.correctionId).toBe('correction-two')
    // Two punches in and two out: an amendment moves a punch, it does not add one.
    expect(corrected).toHaveLength(2)
  })

  it('refuses a correction whose punch is not in the list it is applied to', () => {
    expect(() =>
      applyAttendanceCorrections(
        [punch('clock_in', '18:00')],
        [
          {
            correctionId: 'correction-three',
            employeeId: WORKER,
            tradingDate: DAY,
            adjustmentDate: localDate('2026-08-03'),
            kind: 'supply_missing_clock_out',
            correctsEventId: 'event-not-read',
            correctedOccurredAt: at(NEXT, '02:00'),
          },
        ],
      ),
    ).toThrow(/not in the punch list/)
  })
})

describe('the grace rule version table', () => {
  it('picks the latest version at or before the trading date', () => {
    const later: AttendanceGraceRules = { ...FORGIVING, effectiveFrom: localDate('2026-07-14') }
    expect(attendanceGraceFor([GRACE, later], DAY).graceMinutesAfterStart).toBe(5)
    expect(attendanceGraceFor([GRACE, later], NEXT).graceMinutesAfterStart).toBe(60)
  })

  it('refuses an empty table rather than inventing a window', () => {
    expect(() => attendanceGraceFor([], DAY)).toThrow(/No attendance grace rule version exists/)
  })

  it('refuses a maximum plausible presence of zero, which would pay nobody', () => {
    expect(() =>
      attendanceGraceFor([{ ...GRACE, maximumPlausiblePresenceMinutes: 0 }], DAY),
    ).toThrow(/nobody is ever paid/)
  })

  it('the shipped tolerance cannot make two consecutive days claim one punch', () => {
    // Trading is 11:00-02:00, so one day's close and the next day's open are nine hours apart. A tolerance at
    // or above half of that would make the widened windows overlap and a punch in the overlap would belong to
    // two trading dates with nothing able to choose. Asserted arithmetically rather than by eye, because the
    // figure and the bound both live in the migration and this is the only place the relationship is checked.
    const closeToOpenMinutes = 9 * 60
    expect(GRACE.punchToleranceMinutes * 2).toBeLessThan(closeToOpenMinutes)
    // And the migration's own upper bound holds the same line for a version somebody publishes later.
    expect(240 * 2).toBeLessThan(closeToOpenMinutes)
  })
})

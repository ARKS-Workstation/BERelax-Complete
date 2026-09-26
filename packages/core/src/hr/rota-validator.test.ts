import { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import type { Period } from '../availability/room-predicates.ts'
import { type Instant, instantFromIso, type LocalDate, localDate, localTime } from '../time.ts'
import type { CredentialPolicy, HeldCredential } from './credentials.ts'
import type { WorkingHoursRules } from './rates.ts'
import {
  describeRotaViolation,
  ROTA_RULE_NAMES,
  type RotaCoverageRules,
  type RotaRuleName,
  type RotaTherapist,
  type RotaTradingDay,
  type RotaViolation,
  rotaAssignmentCanonicalForm,
  rotaCoverageRulesFor,
  rotaSegments,
  type TreatmentLoad,
  type ValidateRotaArgs,
  validateOpenShiftClaim,
  validateRota,
  validateSwap,
} from './rota-validator.ts'
import type { RosteredShift } from './working-hours.ts'

/**
 * The rota validator, rule by rule, each with a known-bad fixture rejected BY NAME.
 *
 * ADR 0003 applies hardest to a validator, because a validator is a pile of refusals and a refusal that
 * fires for the wrong reason looks exactly like one that fires for the right reason. So every case here
 * asserts two things: that the good rota passes (the control, without which every refusal below could be
 * the suite simply being red), and that the broken one is refused with **the rule name** the rest of the
 * system stores — `rota_change_request.refused_rule` holds one of these strings and the screen prints one.
 *
 * ## Why the good rota is two 8-hour bands and not one shift a day
 *
 * The first version of this fixture put every therapist on one 11:00–02:00 shift each day, and it could
 * not be a control: **two consecutive full trading days cannot satisfy an 11-hour rest minimum.** The day
 * closes at 02:00 and the next opens at 11:00, which is nine hours, so every therapist breached
 * `minimum_rest` on the "good" rota and every case below was failing two rules at once. That is a true
 * statement about a 15-hour trading day rather than a quirk of the fixture, and the fix is the rota a real
 * salon would write: an early band and a late band, eight hours each, with enough people on both.
 *
 * So the good rota passes against migration 0059's REAL figures — 8 ordinary hours, a 2-hour overtime cap,
 * 48 hours a week, 11 hours of rest — and no case below has to relax them to isolate its own rule.
 */

// ---------------------------------------------------------------------------------------------
// The fixture salon, in miniature: two trading days of 11:00-02:00, five therapists, one wet room.
// ---------------------------------------------------------------------------------------------

const DAY_ONE = localDate('2026-03-04')
const DAY_TWO = localDate('2026-03-05')

/** The early band, and the late band. Eight hours each, overlapping for the 18:00-19:00 handover. */
const EARLY = { from: '11:00', until: '19:00' } as const
const LATE = { from: '18:00', until: '02:00' } as const

const EARLY_THERAPISTS = ['t1', 't2'] as const
const LATE_THERAPISTS = ['t3', 't4', 't5'] as const

/** 11:00 Asia/Dubai is 07:00Z in March: the emirate is UTC+4 all year, with no daylight saving. */
function at(date: LocalDate, time: string): Instant {
  return instantFromIso(`${date}T${time}:00+04:00`)
}

function period(startsAt: Instant, endsAt: Instant): Period {
  return { startsAt, endsAt } as Period
}

/** The next calendar date, stepped at UTC midnight because a `LocalDate` is a label and not an instant. */
function nextCalendarDate(date: LocalDate): LocalDate {
  const stepped = new Date(`${date}T00:00:00Z`)
  stepped.setUTCDate(stepped.getUTCDate() + 1)
  return localDate(stepped.toISOString().slice(0, 10))
}

/** A day that opens at 11:00 and closes at 02:00 the next calendar morning, as `business_day` holds it. */
function tradingDay(date: LocalDate, overrides: Partial<RotaTradingDay> = {}): RotaTradingDay {
  return {
    tradingDate: date,
    opensAt: at(date, '11:00'),
    closesAt: at(nextCalendarDate(date), '02:00'),
    wetRoomBookableDuring: [],
    isPublicHoliday: false,
    ...overrides,
  }
}

/** A band's instants on one trading date. The late band's end falls on the NEXT calendar date. */
function bandPeriod(date: LocalDate, band: { from: string; until: string }): Period {
  const crossesMidnight = band.until < band.from
  return period(
    at(date, band.from),
    at(crossesMidnight ? nextCalendarDate(date) : date, band.until),
  )
}

const MANDATORY_TYPES = ['labour_card', 'occupational_health_card'] as const

const CREDENTIAL_POLICY: CredentialPolicy = {
  mandatoryTypes: [...MANDATORY_TYPES],
  nonExpiringTypes: [],
  expiringSoonDays: 60,
}

/** Every mandatory document, valid for a decade: the eligible case. */
function currentCredentials(): readonly HeldCredential[] {
  return MANDATORY_TYPES.map((documentType) => ({
    documentType,
    expiresOn: localDate('2036-01-01'),
  }))
}

/** Migration 0081's version 1, with the high-intensity list left as shipped (empty) unless overridden. */
function coverageRules(overrides: Partial<RotaCoverageRules> = {}): RotaCoverageRules {
  return {
    effectiveFrom: localDate('1900-01-01'),
    coverageSegmentMinutes: 30,
    minimumTherapistsOnFloor: 2,
    minimumWetRoomCapable: 1,
    treatmentMinutesCapPerDay: 360,
    highIntensityMinutesCapPerDay: 240,
    highIntensityTreatmentCodes: [],
    ...overrides,
  }
}

/** Migration 0059's version 1, whose figures P-HR-05 owns. Copied, never re-derived. */
function workingHoursRules(overrides: Partial<WorkingHoursRules> = {}): WorkingHoursRules {
  return {
    effectiveFrom: localDate('1900-01-01'),
    ordinaryMinutesPerDay: 480,
    ordinaryMinutesPerWeek: 2880,
    weekStartsOn: 1,
    overtimeDailyCapMinutes: 120,
    minimumRestMinutes: 660,
    nightWindow: { from: localTime('22:00'), until: localTime('04:00') },
    multiplierBp: { ordinary: 10_000, overtime: 12_500, night: 15_000, publicHoliday: 15_000 },
    ...overrides,
  }
}

function therapist(id: string, overrides: Partial<RotaTherapist> = {}): RotaTherapist {
  return {
    employeeId: id,
    skills: ['asian_style'],
    credentials: currentCredentials(),
    ...overrides,
  }
}

function shiftId(employeeId: string, date: LocalDate): string {
  return `shift-${employeeId}-${date}`
}

/**
 * A rota that satisfies every rule against 0059's real figures.
 *
 * Two early therapists and three late ones, on both days. Three on the late band and not two, so a case
 * that takes one therapist out to test the containment rule does not also take the floor below its
 * minimum — a case that broke two rules at once could not tell which one it had proved.
 */
function goodRota(): ValidateRotaArgs {
  const days = [tradingDay(DAY_ONE), tradingDay(DAY_TWO)]
  const assignments: RosteredShift[] = []
  for (const day of days) {
    for (const id of EARLY_THERAPISTS) {
      assignments.push({
        shiftId: shiftId(id, day.tradingDate),
        employeeId: id,
        tradingDate: day.tradingDate,
        period: bandPeriod(day.tradingDate, EARLY),
      })
    }
    for (const id of LATE_THERAPISTS) {
      assignments.push({
        shiftId: shiftId(id, day.tradingDate),
        employeeId: id,
        tradingDate: day.tradingDate,
        period: bandPeriod(day.tradingDate, LATE),
      })
    }
  }
  return {
    days,
    therapists: [...EARLY_THERAPISTS, ...LATE_THERAPISTS].map((id) => therapist(id)),
    assignments,
    treatmentLoads: [],
    coverageRuleVersions: [coverageRules()],
    workingHoursRuleVersions: [workingHoursRules()],
    wetRoomSkills: ['asian_style', 'arabic_style'],
    credentialPolicy: CREDENTIAL_POLICY,
  }
}

/** The rule names a validation refused by, in order. What every known-bad case asserts on. */
function rulesRefused(args: ValidateRotaArgs): readonly RotaRuleName[] {
  return validateRota(args).violations.map((violation) => violation.rule)
}

function replaceShift(
  args: ValidateRotaArgs,
  id: string,
  change: (shift: RosteredShift) => RosteredShift,
): readonly RosteredShift[] {
  return args.assignments.map((shift) => (shift.shiftId === id ? change(shift) : shift))
}

// ---------------------------------------------------------------------------------------------

describe('the control: the good rota passes', () => {
  it('publishes, with no violation of any rule, against 0059 version 1 unmodified', () => {
    const result = validateRota(goodRota())
    expect(result.violations).toEqual([])
    expect(result.isPublishable).toBe(true)
  })

  it('covers every segment with at least the minimum, and all five at the handover', () => {
    // Without this the refusals below could all be a validator that refuses everything. Asserting the
    // COUNTS and not just "publishable", because the floor holding at exactly 2 for most of the day is
    // what makes a case that removes one therapist a test of one rule.
    const result = validateRota(goodRota())
    expect(result.segments).toHaveLength(60)
    expect(result.segments.every((segment) => segment.therapistsOnFloor.length >= 2)).toBe(true)
    const handover = result.segments.find((segment) => segment.label === '2026-03-04 18:00-18:30')
    expect(handover?.therapistsOnFloor).toEqual(['t1', 't2', 't3', 't4', 't5'])
    const morning = result.segments.find((segment) => segment.label === '2026-03-04 11:00-11:30')
    expect(morning?.therapistsOnFloor).toEqual(['t1', 't2'])
  })
})

describe('acceptance — coverage is evaluated per 30-minute segment across 11:00-02:00', () => {
  it('produces 30 segments a day, the last of them ending at 02:00', () => {
    const segments = rotaSegments(tradingDay(DAY_ONE), 30)
    // 11:00 to 02:00 is 15 hours: 30 segments of 30 minutes. A naive same-date subtraction gives either
    // -9 hours or 9 hours and 18 segments, and 18 segments would silently stop the rules at midnight.
    expect(segments).toHaveLength(30)
    expect(segments[0]?.label).toBe('2026-03-04 11:00-11:30')
    expect(segments.at(-1)?.label).toBe('2026-03-04 01:30-02:00')
  })

  it('names the post-midnight segments against the PREVIOUS trading date', () => {
    const segments = rotaSegments(tradingDay(DAY_ONE), 30)
    const postMidnight = segments.filter(
      (segment) => segment.label.includes(' 00:') || segment.label.includes(' 01:'),
    )
    // Four of them — 00:00, 00:30, 01:00, 01:30 — every one labelled 2026-03-04 although its instants
    // fall on the 5th. That is the whole of the midnight fix, and the thing a calendar grid gets wrong.
    expect(postMidnight).toHaveLength(4)
    expect(postMidnight.every((segment) => segment.label.startsWith('2026-03-04'))).toBe(true)
    expect(postMidnight[0]?.period.startsAt).toBe(at(DAY_TWO, '00:00'))
  })

  it('asserts the 00:00-02:00 segments are covered, and by the late band only', () => {
    const result = validateRota(goodRota())
    for (const label of [
      '2026-03-04 00:00-00:30',
      '2026-03-04 00:30-01:00',
      '2026-03-04 01:00-01:30',
      '2026-03-04 01:30-02:00',
    ]) {
      const segment = result.segments.find((candidate) => candidate.label === label)
      expect(segment?.therapistsOnFloor).toEqual(['t3', 't4', 't5'])
    }
  })

  it('does not count a shift filed under another trading date, even when it physically overlaps', () => {
    const args = goodRota()
    // t6 is on the floor from 00:00 to 02:00 on the 4th by the clock, and their shift is filed under the
    // 5th. `readEligibleTherapists` joins `shift` on `trading_date`, so the solver cannot find them on
    // either date — the shift is inert, exactly as 0030 says — and coverage must agree with the solver or
    // a rota would pass with cover no booking could use.
    const misfiled: RosteredShift = {
      shiftId: 'shift-t6-misfiled',
      employeeId: 't6',
      tradingDate: DAY_TWO,
      period: period(at(DAY_TWO, '00:00'), at(DAY_TWO, '02:00')),
    }
    const result = validateRota({
      ...args,
      therapists: [...args.therapists, therapist('t6')],
      assignments: [...args.assignments, misfiled],
    })
    const onTheFourth = result.segments.find(
      (segment) => segment.label === '2026-03-04 00:30-01:00',
    )
    expect(onTheFourth?.therapistsOnFloor).toEqual(['t3', 't4', 't5'])
    const onTheFifth = result.segments.filter((segment) => segment.tradingDate === DAY_TWO)
    expect(onTheFifth.some((segment) => segment.therapistsOnFloor.includes('t6'))).toBe(false)
    expect(result.isPublishable).toBe(true)
  })
})

describe('rule 1 — minimum_floor_coverage', () => {
  it('refuses a rota whose post-midnight floor is one short, naming every segment', () => {
    const args = goodRota()
    // Two of the three late therapists go home at midnight on day one.
    let assignments = replaceShift(args, shiftId('t4', DAY_ONE), (shift) => ({
      ...shift,
      period: period(shift.period.startsAt, at(DAY_TWO, '00:00')),
    }))
    assignments = assignments.map((shift) =>
      shift.shiftId === shiftId('t5', DAY_ONE)
        ? { ...shift, period: period(shift.period.startsAt, at(DAY_TWO, '00:00')) }
        : shift,
    )
    const result = validateRota({ ...args, assignments })
    const breaches = result.violations.filter(
      (violation) => violation.rule === 'minimum_floor_coverage',
    )
    expect(result.isPublishable).toBe(false)
    // The labels and not merely the count: "coverage was refused" is satisfied by a validator that
    // refuses the wrong four segments.
    expect(breaches.map((violation) => violation.segmentLabel)).toEqual([
      '2026-03-04 00:00-00:30',
      '2026-03-04 00:30-01:00',
      '2026-03-04 01:00-01:30',
      '2026-03-04 01:30-02:00',
    ])
    expect(breaches.every((violation) => violation.onFloor === 1 && violation.required === 2)).toBe(
      true,
    )
    // And nothing else fired: a shorter shift breaks no hours rule, so this fixture proves one rule.
    expect(result.violations).toHaveLength(4)
  })

  it('counts a therapist only in the segments their presence covers WHOLLY', () => {
    const args = goodRota()
    // t5 leaves at 00:45, fifteen minutes into the 00:30-01:00 segment. The floor holds at 2 there, so
    // the rota still publishes — and t5 must not be counted in that segment, because a rota needing three
    // would otherwise pass with somebody there for half of it.
    const assignments = replaceShift(args, shiftId('t5', DAY_ONE), (shift) => ({
      ...shift,
      period: period(shift.period.startsAt, at(DAY_TWO, '00:45')),
    }))
    const result = validateRota({ ...args, assignments })
    expect(result.isPublishable).toBe(true)
    const before = result.segments.find((segment) => segment.label === '2026-03-04 00:00-00:30')
    expect(before?.therapistsOnFloor).toEqual(['t3', 't4', 't5'])
    const straddled = result.segments.find((segment) => segment.label === '2026-03-04 00:30-01:00')
    expect(straddled?.therapistsOnFloor).toEqual(['t3', 't4'])
  })

  it('merges two abutting shifts into one presence, so a segment across the join is covered', () => {
    const args = goodRota()
    // t3's late band, written as 18:00-22:00 plus 22:00-02:00. The 21:30-22:30 segments straddle the join,
    // and an unmerged reading would find no single shift containing them and report t3 as absent.
    const split: RosteredShift[] = [
      ...args.assignments.filter((shift) => shift.shiftId !== shiftId('t3', DAY_ONE)),
      {
        shiftId: 'shift-t3-first-half',
        employeeId: 't3',
        tradingDate: DAY_ONE,
        period: period(at(DAY_ONE, '18:00'), at(DAY_ONE, '22:00')),
      },
      {
        shiftId: 'shift-t3-second-half',
        employeeId: 't3',
        tradingDate: DAY_ONE,
        period: period(at(DAY_ONE, '22:00'), at(DAY_TWO, '02:00')),
      },
    ]
    const result = validateRota({ ...args, assignments: split })
    const acrossTheJoin = result.segments.find(
      (segment) => segment.label === '2026-03-04 21:30-22:00',
    )
    expect(acrossTheJoin?.therapistsOnFloor).toContain('t3')
    // And the zero-minute gap between the halves is not a rest breach.
    expect(result.violations).toEqual([])
  })

  it('refuses the CALL when an assignment names an employee who is not a therapist', () => {
    const args = goodRota()
    const withFrontDesk: RosteredShift[] = [
      ...args.assignments,
      {
        shiftId: 'shift-reception',
        employeeId: 'reception-1',
        tradingDate: DAY_ONE,
        period: bandPeriod(DAY_ONE, EARLY),
      },
    ]
    // Refused rather than counted, and refused rather than ignored: silently ignoring it is what would
    // let a rota of front-desk staff pass its coverage rule with nobody able to deliver a treatment.
    expect(() => validateRota({ ...args, assignments: withFrontDesk })).toThrow(AppError)
    expect(() => validateRota({ ...args, assignments: withFrontDesk })).toThrow(
      /not in the therapist roster/,
    )
  })
})

describe('acceptance — a bookable wet room with nobody able to run it fails to publish', () => {
  function withWetRoom(args: ValidateRotaArgs, from: string, until: string): ValidateRotaArgs {
    return {
      ...args,
      days: args.days.map((day) =>
        day.tradingDate === DAY_ONE
          ? { ...day, wetRoomBookableDuring: [period(at(DAY_ONE, from), at(DAY_ONE, until))] }
          : day,
      ),
    }
  }

  it('refuses the segment by name when no therapist on the floor holds a wet-room skill', () => {
    const args = withWetRoom(goodRota(), '20:00', '21:00')
    // Nobody holds either style skill. All five are still on the floor, so rule 1 is satisfied and ONLY
    // rule 2 fires — which is what makes this a test of rule 2 rather than of the pair.
    const unskilled = args.therapists.map((person) => ({ ...person, skills: ['front_desk'] }))
    const result = validateRota({ ...args, therapists: unskilled })
    expect(result.violations.map((violation) => violation.rule)).toEqual([
      'wet_room_capability',
      'wet_room_capability',
    ])
    const breaches = result.violations.filter(
      (violation) => violation.rule === 'wet_room_capability',
    )
    expect(breaches.map((violation) => violation.segmentLabel)).toEqual([
      '2026-03-04 20:00-20:30',
      '2026-03-04 20:30-21:00',
    ])
    expect(breaches[0]).toMatchObject({ capableOnFloor: 0, required: 1 })
  })

  it('demands cover for a segment the wet room is bookable in for only part of', () => {
    // Ten minutes of bookable wet room inside the 20:00-20:30 segment. Overlap and not containment, which
    // is the strict direction: somebody has to be able to run the bath for those ten minutes.
    const args = withWetRoom(goodRota(), '20:10', '20:20')
    const unskilled = args.therapists.map((person) => ({ ...person, skills: [] }))
    expect(rulesRefused({ ...args, therapists: unskilled })).toEqual(['wet_room_capability'])
  })

  it('passes when one therapist on the floor holds a wet-room skill, because one is the minimum', () => {
    const args = withWetRoom(goodRota(), '20:00', '21:00')
    const oneCapable = args.therapists.map((person) =>
      person.employeeId === 't3'
        ? { ...person, skills: ['arabic_style'] }
        : { ...person, skills: ['front_desk'] },
    )
    // The control for the two cases above: the rule is satisfiable, so their refusals are about capability
    // and not about the wet room being bookable at all.
    expect(validateRota({ ...args, therapists: oneCapable }).isPublishable).toBe(true)
  })

  it('cannot fire on a day the wet room is not bookable, however unskilled the floor is', () => {
    const args = goodRota()
    const unskilled = args.therapists.map((person) => ({ ...person, skills: [] }))
    expect(rulesRefused({ ...args, therapists: unskilled })).toEqual([])
  })

  it('refuses the CALL when the wet room is bookable and no wet-room skill was supplied at all', () => {
    const args = withWetRoom(goodRota(), '20:00', '21:00')
    // With an empty skill set every segment would be refused and the refusal would name the segment, so
    // the rule would fire for the wrong reason — the defect class this whole file is written against.
    expect(() => validateRota({ ...args, wetRoomSkills: [] })).toThrow(
      /no wet-room skills were supplied/,
    )
  })
})

describe('rule 3 — the daily treatment-load caps', () => {
  const loads = (count: number, treatmentCode = 'asian_massage'): TreatmentLoad[] =>
    Array.from({ length: count }, (_unused, index) => ({
      appointmentId: `appt-${index}`,
      employeeId: 't1',
      tradingDate: DAY_ONE,
      minutes: 60,
      treatmentCode,
    }))

  it('passes at exactly the cap and refuses one minute past it', () => {
    const args = goodRota()
    // Six 60-minute treatments is 360, the cap. The pair matters: `>=` would refuse the rota that is
    // exactly at the cap, and a cap nobody may reach is a different rule from the one Y9-coverage states.
    expect(rulesRefused({ ...args, treatmentLoads: loads(6) })).toEqual([])
    const past: TreatmentLoad[] = [
      ...loads(6),
      {
        appointmentId: 'appt-x',
        employeeId: 't1',
        tradingDate: DAY_ONE,
        minutes: 1,
        treatmentCode: 'asian_massage',
      },
    ]
    const result = validateRota({ ...args, treatmentLoads: past })
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]).toMatchObject({
      rule: 'daily_treatment_load_cap',
      employeeId: 't1',
      tradingDate: DAY_ONE,
      minutes: 361,
      capMinutes: 360,
    })
  })

  it('refuses the high-intensity sub-cap by its OWN name, and not as the total cap', () => {
    const args = goodRota()
    // Five hours of heavy work: inside the 360-minute total and past the 240-minute sub-cap, so only the
    // sub-cap may fire. That is what tells the two rules apart — a validator reporting
    // `daily_treatment_load_cap` here would satisfy a case asserting merely "refused".
    const result = validateRota({
      ...args,
      coverageRuleVersions: [coverageRules({ highIntensityTreatmentCodes: ['deep_tissue'] })],
      treatmentLoads: loads(5, 'deep_tissue'),
    })
    expect(result.violations.map((violation) => violation.rule)).toEqual([
      'daily_high_intensity_load_cap',
    ])
    expect(result.violations[0]).toMatchObject({ minutes: 300, capMinutes: 240 })
  })

  it('counts only the treatments the RULE VERSION names as high-intensity', () => {
    const args = goodRota()
    // Same minutes, same therapist, same day, a different treatment code — and no sub-cap breach, because
    // the classification belongs to the rule version and not to the validator.
    expect(
      rulesRefused({
        ...args,
        coverageRuleVersions: [coverageRules({ highIntensityTreatmentCodes: ['deep_tissue'] })],
        treatmentLoads: loads(5, 'aromatherapy'),
      }),
    ).toEqual([])
  })

  it('cannot fire with the SHIPPED rule version, whose high-intensity list is empty', () => {
    // An assertion about what is shipped rather than about the code. 0081 seeds the list empty on purpose
    // — no service in the catalogue is recorded as heavy work, and 0004 refuses "Therapeutic Deep Tissue"
    // as a claim — so the sub-cap is INERT until Y9-coverage names the treatments. Worth a failing test
    // the day somebody fills the list in without meaning to, and worth being visible rather than a rule
    // that quietly measures nothing.
    const args = goodRota()
    expect(coverageRules().highIntensityTreatmentCodes).toEqual([])
    expect(rulesRefused({ ...args, treatmentLoads: loads(6, 'deep_tissue') })).toEqual([])
  })

  it('refuses a load of zero minutes, which would let a cap be approached and never reached', () => {
    const args = goodRota()
    expect(() =>
      validateRota({
        ...args,
        treatmentLoads: [
          {
            appointmentId: 'appt-0',
            employeeId: 't1',
            tradingDate: DAY_ONE,
            minutes: 0,
            treatmentCode: 'asian_massage',
          },
        ],
      }),
    ).toThrow(/a cap that never fires/)
  })
})

describe("rules 4 — P-HR-05's three, reached through the validator and not re-derived", () => {
  it('refuses a daily overtime breach with 0059 version 1 unmodified', () => {
    const args = goodRota()
    // t3's late band starts at 14:00 instead of 18:00: twelve hours, so 240 minutes of overtime against a
    // 120-minute cap. Coverage only improves, and the rest gap to day two is still sixteen hours, so this
    // fixture breaks one rule.
    const assignments = replaceShift(args, shiftId('t3', DAY_ONE), (shift) => ({
      ...shift,
      period: period(at(DAY_ONE, '14:00'), shift.period.endsAt),
    }))
    const result = validateRota({ ...args, assignments })
    expect(result.violations.map((violation) => violation.rule)).toEqual(['daily_overtime_cap'])
    expect(result.violations[0]).toMatchObject({
      employeeId: 't3',
      tradingDate: DAY_ONE,
      overtimeMinutes: 240,
      capMinutes: 120,
    })
  })

  it('refuses a weekly hours breach, keyed on the trading week', () => {
    const args = goodRota()
    // 960 minutes over the two days for each therapist. A 900-minute weekly cap breaches for all five and
    // leaves every daily figure untouched, so only the weekly rule fires.
    const result = validateRota({
      ...args,
      workingHoursRuleVersions: [workingHoursRules({ ordinaryMinutesPerWeek: 900 })],
    })
    expect(result.violations.map((violation) => violation.rule)).toEqual(
      Array.from({ length: 5 }, () => 'weekly_ordinary_cap'),
    )
    expect(result.violations[0]).toMatchObject({ totalMinutes: 960, capMinutes: 900 })
  })

  it('refuses a rest-gap breach and names both shifts', () => {
    const args = goodRota()
    // A second, separate 60-minute shift for t3 at 11:00 on day one. The gap from 12:00 to the late band
    // at 18:00 is six hours against a minimum of eleven. 540 minutes on the day is still inside the
    // 2-hour overtime cap, so only the rest rule fires.
    const extra: RosteredShift = {
      shiftId: 'shift-t3-extra',
      employeeId: 't3',
      tradingDate: DAY_ONE,
      period: period(at(DAY_ONE, '11:00'), at(DAY_ONE, '12:00')),
    }
    const result = validateRota({ ...args, assignments: [...args.assignments, extra] })
    expect(result.violations.map((violation) => violation.rule)).toEqual(['minimum_rest'])
    expect(result.violations[0]).toMatchObject({
      employeeId: 't3',
      earlierShiftId: 'shift-t3-extra',
      laterShiftId: shiftId('t3', DAY_ONE),
      gapMinutes: 360,
      minimumMinutes: 660,
    })
  })

  it('reports the hours summary alongside, so a screen needs no second read of the shifts', () => {
    const result = validateRota(goodRota())
    // Ten employee-days, and the late band's 240 night minutes are in the night bucket — which is
    // P-HR-05's answer, passed through rather than recomputed here.
    expect(result.workedHours.days).toHaveLength(10)
    const lateDay = result.workedHours.days.find(
      (day) => day.employeeId === 't3' && day.tradingDate === DAY_ONE,
    )
    expect(lateDay?.totalMinutes).toBe(480)
    expect(lateDay?.minutes.night).toBe(240)
  })
})

describe('rule 5 — credential_not_current', () => {
  function withCredentials(
    args: ValidateRotaArgs,
    employeeId: string,
    credentials: readonly HeldCredential[],
  ): ValidateRotaArgs {
    return {
      ...args,
      therapists: args.therapists.map((person) =>
        person.employeeId === employeeId ? { ...person, credentials } : person,
      ),
    }
  }

  it('refuses a therapist whose mandatory document expired before the trading date', () => {
    const result = validateRota(
      withCredentials(goodRota(), 't1', [
        { documentType: 'labour_card', expiresOn: localDate('2026-03-01') },
        { documentType: 'occupational_health_card', expiresOn: localDate('2036-01-01') },
      ]),
    )
    const breaches = result.violations.filter(
      (violation) => violation.rule === 'credential_not_current',
    )
    // One per trading date the therapist is rostered on, because the question is about a DATE.
    expect(breaches.map((violation) => violation.rule)).toEqual([
      'credential_not_current',
      'credential_not_current',
    ])
    const first = breaches[0]
    expect(first).toMatchObject({ employeeId: 't1', tradingDate: DAY_ONE })
    expect(first?.rule === 'credential_not_current' && first.blocking[0]).toMatchObject({
      documentType: 'labour_card',
      status: 'EXPIRED',
    })
  })

  it('refuses a therapist with nothing on file at all, as MISSING', () => {
    const result = validateRota(withCredentials(goodRota(), 't2', []))
    const breaches = result.violations.filter(
      (violation) => violation.rule === 'credential_not_current',
    )
    expect(breaches).toHaveLength(2)
    const first = breaches[0]
    expect(
      first?.rule === 'credential_not_current' &&
        first.blocking.map((assessment) => assessment.status),
    ).toEqual(['MISSING', 'MISSING'])
  })

  it('leaves the dates the document is still valid on alone', () => {
    // Expires on the 4th, and `credentialStatusFor` treats the expiry date as the LAST valid day — so the
    // 4th is fine and the 5th is not. A validator comparing `<=` would refuse both, and a case asserting
    // only "refused" would not notice.
    const result = validateRota(
      withCredentials(goodRota(), 't5', [
        { documentType: 'labour_card', expiresOn: DAY_ONE },
        { documentType: 'occupational_health_card', expiresOn: localDate('2036-01-01') },
      ]),
    )
    const breaches = result.violations.filter(
      (violation) => violation.rule === 'credential_not_current',
    )
    expect(breaches.map((violation) => violation.tradingDate)).toEqual([DAY_TWO])
  })

  it('passes a therapist inside the EXPIRING_SOON window, which is a badge and not a block', () => {
    // P-HR-02's reading, reused rather than re-argued: an unexpired document satisfies the gate however
    // close it is to running out. A validator that blocked on EXPIRING_SOON would take a therapist off a
    // rota sixty days before they became ineligible.
    const result = validateRota(
      withCredentials(goodRota(), 't4', [
        { documentType: 'labour_card', expiresOn: localDate('2026-03-20') },
        { documentType: 'occupational_health_card', expiresOn: localDate('2036-01-01') },
      ]),
    )
    expect(result.violations).toEqual([])
  })
})

describe('acceptance — the validator itself fires when a rule is removed', () => {
  /**
   * The fixture ADR 0003 asks for, as a mutation of the RULE SET rather than of the code.
   *
   * A rule that cannot refuse is what a deleted rule looks like at runtime. Each half asserts the SAME
   * rota is refused under the shipped figures and accepted under the neutered ones, which is what shows
   * the refusal came from the rule rather than from the rota being broken some other way.
   *
   * The source-level form of the same claim — the rule's code deleted from `rota-validator.ts` — is gate
   * block 108 in `scripts/test-gates.mjs`, because a test cannot delete its own dependency.
   */
  it('stops refusing a floor of one once the floor minimum is neutered to one', () => {
    const args = goodRota()
    const oneDay = {
      ...args,
      days: [tradingDay(DAY_ONE)],
      therapists: [therapist('t1')],
      assignments: [
        {
          shiftId: shiftId('t1', DAY_ONE),
          employeeId: 't1',
          tradingDate: DAY_ONE,
          period: bandPeriod(DAY_ONE, EARLY),
        },
      ],
    }
    // 16 segments with one therapist and 14 with none: 30 refusals, all of rule 1.
    expect(rulesRefused(oneDay)).toEqual(Array.from({ length: 30 }, () => 'minimum_floor_coverage'))
    const neutered = validateRota({
      ...oneDay,
      coverageRuleVersions: [
        coverageRules({ minimumTherapistsOnFloor: 1, minimumWetRoomCapable: 0 }),
      ],
    })
    // Fourteen left — the empty segments after 19:00 — and none of them from the first sixteen. A rule
    // "removed" by lowering its threshold stops refusing the rota it was refusing.
    expect(neutered.violations).toHaveLength(14)
    expect(
      neutered.violations.every(
        (violation) => violation.rule === 'minimum_floor_coverage' && violation.onFloor === 0,
      ),
    ).toBe(true)
  })

  it('stops refusing five hours of heavy work once the high-intensity list is emptied', () => {
    const args = goodRota()
    const heavy: TreatmentLoad[] = Array.from({ length: 5 }, (_unused, index) => ({
      appointmentId: `appt-${index}`,
      employeeId: 't1',
      tradingDate: DAY_ONE,
      minutes: 60,
      treatmentCode: 'deep_tissue',
    }))
    expect(
      rulesRefused({
        ...args,
        coverageRuleVersions: [coverageRules({ highIntensityTreatmentCodes: ['deep_tissue'] })],
        treatmentLoads: heavy,
      }),
    ).toEqual(['daily_high_intensity_load_cap'])
    expect(rulesRefused({ ...args, treatmentLoads: heavy })).toEqual([])
  })
})

describe('the versioned thresholds', () => {
  it('picks the version governing each trading date, not the newest one', () => {
    const march = coverageRules({ effectiveFrom: localDate('1900-01-01') })
    const april = coverageRules({
      effectiveFrom: localDate('2026-04-01'),
      minimumTherapistsOnFloor: 3,
    })
    // The whole point of versioning: a rota published in March keeps March's threshold when April raises
    // it, so "was the floor covered on the 4th of March?" has an answer that does not change in April.
    expect(rotaCoverageRulesFor([april, march], DAY_ONE).minimumTherapistsOnFloor).toBe(2)
    expect(
      rotaCoverageRulesFor([april, march], localDate('2026-04-02')).minimumTherapistsOnFloor,
    ).toBe(3)
  })

  it('refuses to invent a rule set when no version governs the date', () => {
    expect(() =>
      rotaCoverageRulesFor([coverageRules({ effectiveFrom: localDate('2026-04-01') })], DAY_ONE),
    ).toThrow(/No rota coverage rule version is effective/)
  })

  it('refuses a rule set whose sub-cap could never fire', () => {
    expect(() =>
      validateRota({
        ...goodRota(),
        coverageRuleVersions: [
          coverageRules({ treatmentMinutesCapPerDay: 100, highIntensityMinutesCapPerDay: 200 }),
        ],
      }),
    ).toThrow(/could never fire/)
  })

  it('refuses a rule set needing more wet-room-capable therapists than the floor holds', () => {
    expect(() =>
      validateRota({
        ...goodRota(),
        coverageRuleVersions: [
          coverageRules({ minimumTherapistsOnFloor: 1, minimumWetRoomCapable: 2 }),
        ],
      }),
    ).toThrow(/no rota could satisfy both/)
  })
})

describe('acceptance — a swap re-runs the full validator and names the breached rule', () => {
  it('accepts a swap onto a therapist who is free, credentialled and rested', () => {
    const args = goodRota()
    const result = validateSwap({
      ...args,
      therapists: [...args.therapists, therapist('t6')],
      shiftId: shiftId('t5', DAY_ONE),
      fromEmployeeId: 't5',
      toEmployeeId: 't6',
    })
    // The control. Without it every refusal below could be a swap validator that refuses every swap.
    expect(result.isPublishable).toBe(true)
  })

  it('refuses a swap that takes the floor below its minimum, naming the coverage rule', () => {
    const args = goodRota()
    // t5's day-one late shift moves to t3, who is already on the late band: one person cannot be in two
    // places, so the floor for 19:00-02:00 falls from three to two... which is still legal. So the rota
    // is first cut to the two-therapist late band, where the same move takes it to one.
    const twoLate = {
      ...args,
      therapists: args.therapists.filter((person) => person.employeeId !== 't5'),
      assignments: args.assignments.filter((shift) => shift.employeeId !== 't5'),
    }
    expect(validateRota(twoLate).isPublishable).toBe(true)
    const result = validateSwap({
      ...twoLate,
      shiftId: shiftId('t4', DAY_ONE),
      fromEmployeeId: 't4',
      toEmployeeId: 't3',
    })
    expect(result.isPublishable).toBe(false)
    const rules = new Set(result.violations.map((violation) => violation.rule))
    expect(rules).toEqual(new Set(['minimum_floor_coverage']))
    const first = result.violations[0] as RotaViolation
    expect(describeRotaViolation(first)).toMatch(/1 therapist\(s\) on the floor, 2 required/)
  })

  it('refuses a swap onto a therapist whose credentials are not current', () => {
    const args = goodRota()
    const result = validateSwap({
      ...args,
      therapists: [...args.therapists, therapist('t6', { credentials: [] })],
      shiftId: shiftId('t5', DAY_ONE),
      fromEmployeeId: 't5',
      toEmployeeId: 't6',
    })
    expect(result.violations.map((violation) => violation.rule)).toEqual(['credential_not_current'])
  })

  it('refuses a swap that would breach the incoming therapist’s rest gap', () => {
    const args = goodRota()
    // t1's day-two EARLY shift moves to t3, who worked the late band until 02:00 that morning. Nine hours
    // of rest against eleven — the breach a swap is most likely to create and least likely to be noticed,
    // because neither shift is unusual on its own.
    const result = validateSwap({
      ...args,
      shiftId: shiftId('t1', DAY_TWO),
      fromEmployeeId: 't1',
      toEmployeeId: 't3',
    })
    expect(result.violations.map((violation) => violation.rule)).toContain('minimum_rest')
  })

  it('refuses a swap that names a shift the giver is not on', () => {
    const args = goodRota()
    expect(() =>
      validateSwap({
        ...args,
        shiftId: shiftId('t1', DAY_ONE),
        fromEmployeeId: 't2',
        toEmployeeId: 't3',
      }),
    ).toThrow(/is not assigned to employee/)
  })

  it('refuses a swap onto somebody already on that shift', () => {
    const args = goodRota()
    const doubled: RosteredShift[] = [
      ...args.assignments,
      {
        shiftId: shiftId('t1', DAY_ONE),
        employeeId: 't2',
        tradingDate: DAY_ONE,
        period: bandPeriod(DAY_ONE, EARLY),
      },
    ]
    expect(() =>
      validateSwap({
        ...args,
        assignments: doubled,
        shiftId: shiftId('t1', DAY_ONE),
        fromEmployeeId: 't1',
        toEmployeeId: 't2',
      }),
    ).toThrow(/already on shift/)
  })
})

describe('acceptance — an open shift claimed with an expired credential is refused', () => {
  const OPEN_SHIFT = 'shift-open-1'

  it('refuses the claim by rule name, through the P-HR-02 evaluator', () => {
    const args = goodRota()
    const lapsed = therapist('t6', {
      credentials: [
        { documentType: 'labour_card', expiresOn: localDate('2026-03-01') },
        { documentType: 'occupational_health_card', expiresOn: localDate('2036-01-01') },
      ],
    })
    const result = validateOpenShiftClaim({
      ...args,
      therapists: [...args.therapists, lapsed],
      shiftId: OPEN_SHIFT,
      tradingDate: DAY_ONE,
      period: bandPeriod(DAY_ONE, EARLY),
      claimedBy: 't6',
    })
    expect(result.isPublishable).toBe(false)
    expect(result.violations.map((violation) => violation.rule)).toEqual(['credential_not_current'])
  })

  it('accepts the same claim from a therapist whose file is current', () => {
    const args = goodRota()
    const result = validateOpenShiftClaim({
      ...args,
      therapists: [...args.therapists, therapist('t6')],
      shiftId: OPEN_SHIFT,
      tradingDate: DAY_ONE,
      period: bandPeriod(DAY_ONE, EARLY),
      claimedBy: 't6',
    })
    // The control: without it the case above could be refusing every claim.
    expect(result.isPublishable).toBe(true)
  })

  it('refuses a claim on a shift that already has somebody on it', () => {
    const args = goodRota()
    expect(() =>
      validateOpenShiftClaim({
        ...args,
        therapists: [...args.therapists, therapist('t6')],
        shiftId: shiftId('t1', DAY_ONE),
        tradingDate: DAY_ONE,
        period: bandPeriod(DAY_ONE, EARLY),
        claimedBy: 't6',
      }),
    ).toThrow(/already has somebody on it/)
  })
})

describe('the canonical form the digest is taken over', () => {
  const row = {
    employeeId: 't1',
    tradingDate: DAY_ONE,
    startsAt: at(DAY_ONE, '11:00'),
    endsAt: at(DAY_ONE, '19:00'),
  }

  it('is independent of the order the rows arrive in', () => {
    const rows = [{ ...row, employeeId: 't2' }, row]
    expect(rotaAssignmentCanonicalForm(rows)).toBe(rotaAssignmentCanonicalForm([...rows].reverse()))
  })

  it('changes when any one field changes, including the end instant', () => {
    // The control for the order-independence claim above: a form that ignored its fields would also be
    // order-independent, and would report every rota as unchanged for ever.
    expect(rotaAssignmentCanonicalForm([row])).not.toBe(
      rotaAssignmentCanonicalForm([{ ...row, endsAt: at(DAY_ONE, '19:30') }]),
    )
    expect(rotaAssignmentCanonicalForm([row])).not.toBe(
      rotaAssignmentCanonicalForm([{ ...row, employeeId: 't2' }]),
    )
    expect(rotaAssignmentCanonicalForm([row])).not.toBe(
      rotaAssignmentCanonicalForm([{ ...row, tradingDate: DAY_TWO }]),
    )
  })

  it('does not collapse a duplicate row', () => {
    expect(rotaAssignmentCanonicalForm([row, row])).not.toBe(rotaAssignmentCanonicalForm([row]))
  })
})

describe('the rule-name vocabulary', () => {
  it('is exactly the eight names the database and the screen store', () => {
    // Enumerated rather than counted, so a ninth rule is a visible change here and in 0081's comment on
    // `rota_change_request.refused_rule` rather than a silent widening.
    expect([...ROTA_RULE_NAMES]).toEqual([
      'minimum_floor_coverage',
      'wet_room_capability',
      'daily_treatment_load_cap',
      'daily_high_intensity_load_cap',
      'daily_overtime_cap',
      'weekly_ordinary_cap',
      'minimum_rest',
      'credential_not_current',
    ])
  })

  it('has a description carrying a figure for every one of them', () => {
    // A rule with no wording reaches `rota_change_request.refusal_detail` as the string "undefined", which
    // is a refusal nobody can answer. One violation of each of the eight is described, and the VOCABULARY
    // is what the loop walks — a case that walked a list written here would pass while the ninth rule had
    // no wording at all.
    const samples: Record<RotaRuleName, RotaViolation> = {
      minimum_floor_coverage: {
        rule: 'minimum_floor_coverage',
        tradingDate: DAY_ONE,
        segmentLabel: '2026-03-04 00:30-01:00',
        segmentIndex: 27,
        onFloor: 1,
        required: 2,
      },
      wet_room_capability: {
        rule: 'wet_room_capability',
        tradingDate: DAY_ONE,
        segmentLabel: '2026-03-04 20:00-20:30',
        segmentIndex: 18,
        capableOnFloor: 0,
        required: 1,
      },
      daily_treatment_load_cap: {
        rule: 'daily_treatment_load_cap',
        tradingDate: DAY_ONE,
        employeeId: 't1',
        minutes: 361,
        capMinutes: 360,
        appointmentIds: ['appt-1'],
      },
      daily_high_intensity_load_cap: {
        rule: 'daily_high_intensity_load_cap',
        tradingDate: DAY_ONE,
        employeeId: 't1',
        minutes: 300,
        capMinutes: 240,
        appointmentIds: ['appt-1'],
      },
      daily_overtime_cap: {
        rule: 'daily_overtime_cap',
        tradingDate: DAY_ONE,
        employeeId: 't1',
        overtimeMinutes: 240,
        capMinutes: 120,
      },
      weekly_ordinary_cap: {
        rule: 'weekly_ordinary_cap',
        employeeId: 't1',
        weekStartTradingDate: localDate('2026-03-02'),
        totalMinutes: 960,
        capMinutes: 900,
      },
      minimum_rest: {
        rule: 'minimum_rest',
        employeeId: 't1',
        earlierShiftId: 'shift-a',
        laterShiftId: 'shift-b',
        gapMinutes: 540,
        minimumMinutes: 660,
      },
      credential_not_current: {
        rule: 'credential_not_current',
        employeeId: 't1',
        tradingDate: DAY_ONE,
        blocking: [
          {
            documentType: 'labour_card',
            status: 'EXPIRED',
            expiresOn: localDate('2026-03-01'),
            daysUntilExpiry: -3,
            isMandatory: true,
          },
        ],
      },
    }
    for (const rule of ROTA_RULE_NAMES) {
      const described = describeRotaViolation(samples[rule])
      expect(described.length).toBeGreaterThan(20)
      // Each wording must carry a FIGURE: "coverage is short" without the numbers is a refusal nobody can
      // act on, and an empty-string implementation would satisfy a length check on its own.
      expect(described).toMatch(/\d/)
    }
  })
})
